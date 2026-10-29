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
//   feedback  every row, after the lookups, with `given_at` = the row's
//             updated_at (when the 👍/👎 was saved; the live send does the
//             same). The store ignores a verdict older than the one it holds
//             and the same verdict sent twice, so a re-send (a first run
//             after the 28 Oct backfill, a send that timed out but landed)
//             changes nothing. A store from before given_at answers 422
//             invalid_request: sent once more without it (postFeedback).
//             A 👍/👎 on a value needs that value stored first: while the
//             person has an unsynced vendor row with values written less than
//             FEEDBACK_WAIT_MS (24 h) ago, its feedback waits for a later run
//             and does not use one of the run's rows. After that the row is
//             failing for its own reason and the 👍/👎 goes anyway. A 404
//             contact_not_found (the store does not hold the value) saves the
//             value from Lyca's own row, then sends the 👍/👎 once more.
//             Clearing a thumb deletes the row; the store keeps its last
//             verdict (as before HIR-526: the store has no "clear").
//
// Bounds: at most SYNC_MAX_ROWS rows that take a store call per run, feedback
// read in at most FEEDBACK_SCAN_PAGES pages (each SYNC_MAX_ROWS more rows than
// the last, waiting ones skipped), and nothing new
// after SYNC_BUDGET_MS: every call's timeout is cut to what is left of the
// run, retries included. A run out of time leaves the rest for the next one.
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
  postFeedback,
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
/** A 👍/👎 waits for its person's unsynced values at most this long (by that row's updated_at). */
export const FEEDBACK_WAIT_MS = 24 * 60 * 60 * 1000
/** Pages of feedback (SYNC_MAX_ROWS each) read per run at most, waiting ones included. */
export const FEEDBACK_SCAN_PAGES = 5

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
  updated_at: string
}

/** Everything the job reads and writes in Lyca's database (store-sync-db.ts). */
export interface SyncDb {
  /** Marks unsynced rows with nothing to send (contact_store, or a vendor row without values). Returns how many. */
  settleLookups(): Promise<number>
  /** Unsynced rows of salesql / bettercontact, oldest first. */
  unsyncedLookups(limit: number): Promise<LookupSyncRow[]>
  /** Unsynced feedback rows, oldest first (then by id). */
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
  /** The run's clock (budget and call timeouts). */
  now?: () => number
  /** Wall-clock time, for how long feedback waits (FEEDBACK_WAIT_MS). */
  wallNow?: () => number
  feedbackWaitMs?: number
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
/** The run's time is used up: the rest waits for the next run (not an error). */
class OutOfTime extends Error {}

/** Rethrows what must stop the run (as StopRun / OutOfTime); returns for a per-row failure. */
function stopOn(err: unknown): void {
  if (err instanceof StopRun || err instanceof OutOfTime) throw err
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
  const wallNow = options.wallNow ?? Date.now
  const waitLimit = options.feedbackWaitMs ?? FEEDBACK_WAIT_MS
  const deadline = now() + (options.budgetMs ?? SYNC_BUDGET_MS)
  const counts: SyncCounts = {
    status: 'ok',
    lookups: { sent: 0, settled: 0, dropped_values: 0, failed: 0 },
    feedback: { sent: 0, waiting: 0, rejected: 0, failed: 0 },
    more: false,
  }
  const timeLeft = () => now() < deadline
  /** Each call gets at most what is left of the run (OutOfTime when nothing is). */
  const callTimeout = () => {
    const left = deadline - now()
    if (left <= 0) throw new OutOfTime('run budget used')
    return Math.max(1, Math.min(timeout, left))
  }
  const send = (path: string, body: unknown) => post(path, body, callTimeout())
  const sendFeedback = (body: ReturnType<typeof storeFeedbackBody>) =>
    postFeedback(body, callTimeout())

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
        // One bad value refuses the whole call: send them one by one (while time is left).
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

  /** Rows that took a store call (or were marked) this run; waiting feedback does not count. */
  let processed = 0
  try {
    counts.lookups.settled += await db.settleLookups()

    // 1. Lookups, oldest first: the values must be in the store before any 👍/👎 on them.
    const lookups = await db.unsyncedLookups(maxRows)
    if (lookups.length >= maxRows) counts.more = true
    for (const row of lookups) {
      if (!timeLeft()) throw new OutOfTime('run budget used')
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
        if (err instanceof OutOfTime) throw err
        counts.lookups.failed += 1
        stopOn(err)
        console.warn(
          'contact store sync: one lookup row left for later:',
          describe(err),
        )
      }
    }

    // 2. Feedback, oldest first, in pages, until the run's rows are used up.
    // A 👍/👎 waiting for its person's values is skipped without using a row.
    // Each page reads from the start again, as many more rows as were already
    // seen (sent rows drop out of the unsynced set, the others are skipped).
    const seen = new Set<string>()
    for (let page = 0; ; page++) {
      if (processed >= maxRows) {
        counts.more = true
        break
      }
      if (page >= FEEDBACK_SCAN_PAGES) {
        counts.more = true
        break
      }
      if (!timeLeft()) throw new OutOfTime('run budget used')
      const limit = seen.size + maxRows
      const fetched = await db.unsyncedFeedback(limit)
      const feedback = fetched.filter((f) => !seen.has(f.id))
      if (!feedback.length) break
      for (const f of feedback) seen.add(f.id)
      const people = await db.personRows([
        ...new Set(feedback.map((f) => f.linkedin_key)),
      ])
      for (const f of feedback) {
        if (processed >= maxRows) {
          counts.more = true
          break
        }
        if (!timeLeft()) throw new OutOfTime('run budget used')
        const mine = people.filter((p) => p.linkedin_key === f.linkedin_key)
        if (waitsForValues(mine, wallNow(), waitLimit)) {
          counts.feedback.waiting += 1
          counts.more = true
          continue
        }
        processed += 1
        const url =
          mine.find((p) => p.linkedin_url)?.linkedin_url ??
          profileUrlOf(f.linkedin_key)
        // given_at = when the 👍/👎 was saved: the store ignores it if it
        // already holds this verdict or a newer one (first runs, retries).
        const body = storeFeedbackBody(
          url,
          f.contact_kind,
          f.contact_value,
          f.verdict,
          f.reason,
          f.updated_at,
        )
        try {
          try {
            await sendFeedback(body)
          } catch (err) {
            if (!isNotFound(err)) throw err
            // The store does not hold the value: save it from Lyca's own row, then once more.
            const value = valueFromRows(mine, f)
            if (!value) throw err
            const refused = await save(url, [value])
            if (refused) throw err
            await sendFeedback(body)
          }
          if (await db.markFeedback(f.id, f.updated_at))
            counts.feedback.sent += 1
        } catch (err) {
          if (err instanceof OutOfTime) throw err
          if (err instanceof StopRun || isOutage(err))
            counts.feedback.failed += 1
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
      if (fetched.length < limit) break // that was the last page
    }
  } catch (err) {
    if (err instanceof OutOfTime) {
      counts.more = true
      return counts
    }
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

/**
 * Whether a 👍/👎 waits for its person's values: one of Lyca's vendor rows
 * with values is not in the store yet, and was written less than `limitMs`
 * ago. An older unsynced row is failing for its own reason; the 👍/👎 then
 * goes anyway (a 404 saves the value from Lyca's row first).
 */
export function waitsForValues(
  rows: PersonSyncRow[],
  wallNow: number,
  limitMs: number,
): boolean {
  return rows.some(
    (p) =>
      p.store_synced_at === null &&
      (p.vendor === 'salesql' || p.vendor === 'bettercontact') &&
      lookupContacts(p).length > 0 &&
      wallNow - Date.parse(p.updated_at) < limitMs,
  )
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
