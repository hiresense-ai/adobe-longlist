// Catch-up for the shared contact store (HIR-526). Every contact Lyca reveals
// and every 👍/👎 must reach the store (contact-store.ts), even when the store
// was down at the time. Each row of candidate_contact_lookups and
// candidate_contact_feedback carries `store_synced_at`:
//
//   null      the store may not hold this version of the row yet. Every
//             insert/upsert of a row sets it back to null (upsertUnsynced).
//   a time    the store took this version (or it has nothing to send).
//
// The background send after a reveal / 👍/👎 marks the row on success; the
// contact-store-sync Edge Function (every 10 minutes) sends whatever is still
// null. A row is only ever marked when it is unchanged since what was sent:
// the mark matches id AND updated_at (which every write sets), so a newer
// version written meanwhile stays null and is sent next time.
//
// What is sent, and what is only marked:
//   lookups   rows of vendor salesql / bettercontact that hold values: every
//             value of the row, both kinds (the store is idempotent: a value
//             it holds is not duplicated and keeps its status). Rows of vendor
//             contact_store (the store's own answer, nothing to give back) and
//             vendor rows without a single value (not_found, error, a search
//             still running) are marked without a call ("settled"). A row
//             that later gets values is written again, so it is null again.
//   feedback  every row, after the lookups: a 👍/👎 on a value needs that
//             value stored first. While the person still has an unsynced
//             vendor row with values, its feedback waits for a later run. A
//             404 contact_not_found (the store does not hold the value) saves
//             the value from Lyca's own row, then sends the 👍/👎 once more.
//             Clearing a thumb deletes the row; the store keeps its last
//             verdict (as before HIR-526: the store has no "clear").
//
// Errors: the store down / slow / 5xx / 429 / 401 / 403 stops the run with
// the rows left null. 409 (busy) leaves that row for the next run. A 400 /
// 422 is the store refusing the data itself, which no retry changes: a save
// is retried one value at a time and the refused values are dropped; a
// refused 👍/👎 is dropped. Those rows are marked, so they never block the
// queue (counted as dropped / rejected).
//
// Logs and the returned counts never carry an email, phone or LinkedIn URL.

import {
  ContactStoreUnavailable,
  post,
  SAVE_BATCH,
  storeContactsFrom,
  storeFeedbackBody,
  type StoreContactInput,
} from './contact-store.ts'
import type { ContactKind } from './vendors.ts'

/** One store call in the job may take this long (the run as a whole is bounded too). */
export const SYNC_CALL_TIMEOUT_MS = 10_000
/** Rows (lookups + feedback) sent per run at most. */
export const SYNC_MAX_ROWS = 200
/** A run starts no new row after this long, well inside the Edge Function limit. */
export const SYNC_BUDGET_MS = 50_000

export interface LookupSyncRow {
  id: string
  linkedin_key: string
  linkedin_url: string
  vendor: string
  emails: unknown
  phones: unknown
  updated_at: string
}

export interface FeedbackSyncRow {
  id: string
  linkedin_key: string
  contact_kind: ContactKind
  contact_value: string
  vendor: string
  verdict: 'good' | 'bad'
  reason: string | null
  updated_at: string
}

/** A person's lookup rows, as the feedback step needs them. */
export interface PersonSyncRow {
  linkedin_key: string
  linkedin_url: string
  vendor: string
  status: string
  emails: unknown
  phones: unknown
  store_synced_at: string | null
}

/** Everything the job reads and writes in Lyca's database (store-sync-db.ts). */
export interface SyncDb {
  /** Marks unsynced rows with nothing to send (contact_store, or a vendor row without values). Returns how many. */
  settleLookups(): Promise<number>
  /** Unsynced rows of salesql / bettercontact, oldest first. */
  unsyncedLookups(limit: number): Promise<LookupSyncRow[]>
  /** Unsynced feedback rows, oldest first. */
  unsyncedFeedback(limit: number): Promise<FeedbackSyncRow[]>
  /** Every lookup row of these people. */
  personRows(keys: string[]): Promise<PersonSyncRow[]>
  /** Marks the row synced only if it still has this updated_at and is unsynced. */
  markLookup(id: string, updatedAt: string): Promise<boolean>
  markFeedback(id: string, updatedAt: string): Promise<boolean>
}

export interface SyncCounts {
  status: 'ok' | 'stopped'
  lookups: {
    sent: number
    settled: number
    dropped_values: number
    failed: number
  }
  feedback: { sent: number; waiting: number; rejected: number; failed: number }
  /** True when rows may be left for the next run (cap, time, or a stop). */
  more: boolean
}

export interface SyncOptions {
  maxRows?: number
  budgetMs?: number
  callTimeoutMs?: number
  now?: () => number
}

/** A database error whose message is only a code: safe to log (store-sync-db.ts). */
export class SyncDbError extends Error {}

/**
 * Stop the run, retry next time: the store itself (or Lyca's access to it) is
 * the problem, or something unexpected failed (Lyca's database included).
 */
function isOutage(err: unknown): boolean {
  if (!(err instanceof ContactStoreUnavailable)) return true
  const s = err.status
  return s === null || s >= 500 || s === 429 || s === 401 || s === 403
}

/** The store refused the data itself: no retry will change that. */
function isRefusal(err: unknown): boolean {
  return (
    err instanceof ContactStoreUnavailable &&
    (err.status === 400 || err.status === 422)
  )
}

function isNotFound(err: unknown): boolean {
  return err instanceof ContactStoreUnavailable && err.status === 404
}

/** Only a status and code, never the request: safe to log. */
function describe(err: unknown): string {
  if (err instanceof ContactStoreUnavailable) {
    return err.status === null ? 'store unreachable' : err.message
  }
  if (err instanceof SyncDbError || err instanceof StopRun) return err.message
  return err instanceof Error ? err.name : 'error'
}

class StopRun extends Error {}

/** Rethrows what must stop the run (as StopRun); returns for a per-row failure. */
function stopOn(err: unknown): void {
  if (err instanceof StopRun) throw err
  if (isOutage(err)) throw new StopRun(describe(err))
}

/** The version of a row just written: what its "synced" mark must match. */
export interface RowVersion {
  id: string
  updated_at: string
}

/** The one call upsertUnsynced makes (a Supabase client has it). */
export interface UpsertClient {
  from(table: string): {
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): {
      select(columns: string): {
        single(): PromiseLike<{
          data: unknown
          error: { code?: string } | null
        }>
      }
    }
  }
}

/**
 * Every insert/upsert of a lookup or feedback row goes through here: it sets
 * a fresh updated_at and store_synced_at back to null, so the values just
 * written count as not yet in the store until a send of exactly this version
 * lands. Returns that version (id + updated_at) for the mark.
 */
export async function upsertUnsynced(
  client: UpsertClient,
  table: 'candidate_contact_lookups' | 'candidate_contact_feedback',
  row: Record<string, unknown>,
  onConflict: string,
): Promise<RowVersion> {
  const { data, error } = await client
    .from(table)
    .upsert(
      { ...row, updated_at: new Date().toISOString(), store_synced_at: null },
      { onConflict },
    )
    .select('id, updated_at')
    .single()
  if (error) throw error
  const saved = data as Partial<RowVersion> | null
  if (!saved?.id || !saved.updated_at) {
    throw new SyncDbError(`write ${table}: no row returned`)
  }
  return { id: saved.id, updated_at: saved.updated_at }
}

/** The profile URL for a key ("linkedin.com/in/jane-doe"), when no row has one. */
export function profileUrlOf(linkedinKey: string): string {
  return `https://www.${linkedinKey}`
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * The store's contacts for one lookup row, the same mapping as the save after
 * a reveal (and scripts/backfill-contact-store.mjs).
 */
export function lookupContacts(row: {
  vendor: string
  emails: unknown
  phones: unknown
}): StoreContactInput[] {
  return storeContactsFrom(row.vendor, {
    emails: asList(row.emails),
    phones: asList(row.phones),
  })
}

export async function runSync(
  db: SyncDb,
  options: SyncOptions = {},
): Promise<SyncCounts> {
  const maxRows = options.maxRows ?? SYNC_MAX_ROWS
  const timeout = options.callTimeoutMs ?? SYNC_CALL_TIMEOUT_MS
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? SYNC_BUDGET_MS)
  const counts: SyncCounts = {
    status: 'ok',
    lookups: { sent: 0, settled: 0, dropped_values: 0, failed: 0 },
    feedback: { sent: 0, waiting: 0, rejected: 0, failed: 0 },
    more: false,
  }
  const send = (path: string, body: unknown) => post(path, body, timeout)

  /** Saves one person's values; returns how many the store refused. Throws StopRun on an outage. */
  async function save(
    linkedinUrl: string,
    contacts: StoreContactInput[],
  ): Promise<number> {
    let refused = 0
    for (let i = 0; i < contacts.length; i += SAVE_BATCH) {
      const chunk = contacts.slice(i, i + SAVE_BATCH)
      try {
        await send('/v1/contacts', {
          linkedin_url: linkedinUrl,
          contacts: chunk,
        })
      } catch (err) {
        stopOn(err)
        if (!isRefusal(err)) throw err
        // One bad value refuses the whole call: send them one by one.
        for (const contact of chunk) {
          try {
            await send('/v1/contacts', {
              linkedin_url: linkedinUrl,
              contacts: [contact],
            })
          } catch (one) {
            stopOn(one)
            if (!isRefusal(one)) throw one
            refused += 1
          }
        }
      }
    }
    return refused
  }

  let processed = 0
  try {
    counts.lookups.settled += await db.settleLookups()

    // 1. Lookups, oldest first: the values must be in the store before any 👍/👎 on them.
    const lookups = await db.unsyncedLookups(maxRows)
    if (lookups.length >= maxRows) counts.more = true
    for (const row of lookups) {
      if (now() >= deadline) {
        counts.more = true
        break
      }
      processed += 1
      // Only Lyca's own vendors' values go to the store: never its own answers back.
      const vendorRow =
        row.vendor === 'salesql' || row.vendor === 'bettercontact'
      const contacts = vendorRow ? lookupContacts(row) : []
      if (!contacts.length) {
        if (await db.markLookup(row.id, row.updated_at))
          counts.lookups.settled += 1
        continue
      }
      try {
        const refused = await save(row.linkedin_url, contacts)
        counts.lookups.dropped_values += refused
        if (await db.markLookup(row.id, row.updated_at))
          counts.lookups.sent += 1
      } catch (err) {
        counts.lookups.failed += 1
        stopOn(err)
        console.warn(
          'contact store sync: one lookup row left for later:',
          describe(err),
        )
      }
    }

    // 2. Feedback, oldest first, with whatever room is left in this run.
    const room = maxRows - processed
    if (room <= 0 || now() >= deadline) {
      counts.more = true
      return counts
    }
    const feedback = await db.unsyncedFeedback(room)
    if (feedback.length >= room) counts.more = true
    const people = await db.personRows([
      ...new Set(feedback.map((f) => f.linkedin_key)),
    ])
    for (const f of feedback) {
      if (now() >= deadline) {
        counts.more = true
        break
      }
      const mine = people.filter((p) => p.linkedin_key === f.linkedin_key)
      // A vendor row whose values are not in the store yet: those first (a later run).
      const valuesPending = mine.some(
        (p) =>
          p.store_synced_at === null &&
          (p.vendor === 'salesql' || p.vendor === 'bettercontact') &&
          lookupContacts(p).length > 0,
      )
      if (valuesPending) {
        counts.feedback.waiting += 1
        counts.more = true
        continue
      }
      const url =
        mine.find((p) => p.linkedin_url)?.linkedin_url ??
        profileUrlOf(f.linkedin_key)
      const body = storeFeedbackBody(
        url,
        f.contact_kind,
        f.contact_value,
        f.verdict,
        f.reason,
      )
      try {
        try {
          await send('/v1/contacts/feedback', body)
        } catch (err) {
          if (!isNotFound(err)) throw err
          // The store does not hold the value: save it from Lyca's own row, then once more.
          const value = valueFromRows(mine, f)
          if (!value) throw err
          const refused = await save(url, [value])
          if (refused) throw err
          await send('/v1/contacts/feedback', body)
        }
        if (await db.markFeedback(f.id, f.updated_at)) counts.feedback.sent += 1
      } catch (err) {
        if (err instanceof StopRun || isOutage(err)) counts.feedback.failed += 1
        stopOn(err)
        if (isRefusal(err) || isNotFound(err)) {
          // The store will never take this one: drop it so it never blocks the queue.
          if (await db.markFeedback(f.id, f.updated_at))
            counts.feedback.rejected += 1
          continue
        }
        counts.feedback.failed += 1
        console.warn(
          'contact store sync: one feedback row left for later:',
          describe(err),
        )
      }
    }
  } catch (err) {
    if (!(err instanceof StopRun)) throw err
    counts.status = 'stopped'
    counts.more = true
    console.warn(
      'contact store sync stopped, the rest waits for the next run:',
      err.message,
    )
  }
  return counts
}

/** The 👍/👎'd value as Lyca's own row holds it (the row of the feedback's vendor first). */
function valueFromRows(
  rows: PersonSyncRow[],
  f: FeedbackSyncRow,
): StoreContactInput | null {
  const ordered = [
    ...rows.filter((r) => r.vendor === f.vendor),
    ...rows.filter((r) => r.vendor !== f.vendor),
  ]
  for (const row of ordered) {
    const vendor =
      row.vendor === 'salesql' || row.vendor === 'bettercontact'
        ? row.vendor
        : null
    const match = storeContactsFrom(vendor, {
      emails: f.contact_kind === 'email' ? asList(row.emails) : [],
      phones: f.contact_kind === 'phone' ? asList(row.phones) : [],
    }).find((c) => c.value === f.contact_value)
    if (match) return match
  }
  return null
}
