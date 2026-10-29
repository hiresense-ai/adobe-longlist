// The shared contact store (hiresense-ai/contact-enrichment): one place where every HireSense
// platform keeps the contacts it revealed. "Get contact" asks it first; it answers from what any
// platform already revealed, then from ZipLabs. Only when it has nothing does SalesQL run. What
// SalesQL or BetterContact find, and every thumbs up / down, is written back so no platform pays for
// the same contact twice.
//
// Settings (supabase/functions/.env locally, function secrets on the project):
//   CONTACT_ENRICHMENT_URL       e.g. http://host.docker.internal:4100 for a service on this machine
//   CONTACT_ENRICHMENT_API_KEY   Lyca's key in that service's PLATFORM_API_KEYS
//   CONTACT_ENRICHMENT_TIMEOUT_MS  optional; how long a reveal waits for the store's lookup
//                                (default 8000: a first ZipLabs answer through the store takes
//                                several seconds, SHARED_CONTRACT.md §3). A lookup that times
//                                out is treated like the store being down: the vendors run.
//                                Background saves and 👍/👎 have their own short timeout
//                                (BACKGROUND_TIMEOUT_MS), so they never hold a worker long.
// With URL or key missing, nothing here is called and the lookup works exactly as before.
//
// Only the lookup is waited for. Saves and 👍/👎 go to the store in the background
// (contactStoreSaveLater / contactStoreFeedbackLater), so a slow or down store never delays a
// reveal; their failures are logged, never shown. A send that lands marks its row synced
// (store_synced_at, through the `onSent` callback); one that fails leaves the row unsynced and
// the contact-store-sync job (store-sync.ts) sends it later (HIR-526).

import type {
  ContactEmail,
  ContactKind,
  ContactPhone,
  VendorResult,
} from './vendors.ts'

export const DEFAULT_TIMEOUT_MS = 8_000
/** Background saves and 👍/👎 (not waited for by anyone) give up after this long. */
export const BACKGROUND_TIMEOUT_MS = 3_000

/** CONTACT_ENRICHMENT_TIMEOUT_MS, or 8000 when unset or not a positive number. */
export function contactStoreTimeoutMs(): number {
  const raw = Number(Deno.env.get('CONTACT_ENRICHMENT_TIMEOUT_MS')?.trim())
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS
}

/**
 * Lets `task` finish after the response has gone out. In the Supabase edge
 * runtime that is EdgeRuntime.waitUntil (the worker stays up for it);
 * elsewhere the promise simply runs on, not awaited. Never throws, and a
 * failing task is only logged.
 */
export function inBackground(task: Promise<unknown>, label: string): void {
  const guarded = task.catch((err) => {
    console.warn(
      `${label} failed:`,
      err instanceof Error ? err.message : String(err),
    )
  })
  const runtime = (
    globalThis as {
      EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void }
    }
  ).EdgeRuntime
  if (typeof runtime?.waitUntil === 'function') {
    try {
      runtime.waitUntil(guarded)
    } catch {
      // the guarded promise still runs on its own
    }
  }
}

interface StoreContact {
  value: string
  status: 'good' | 'bad' | 'unknown'
  verified: boolean | null
}

/**
 * The store could not take a call. `status` is the HTTP status (null when it
 * was never reached: down, slow, refused) and `code` the store's error code,
 * e.g. "contact_not_found". The message never holds a contact value.
 */
export class ContactStoreUnavailable extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public code = '',
  ) {
    super(message)
  }
}

function settings(): { url: string; key: string } | null {
  const url = Deno.env.get('CONTACT_ENRICHMENT_URL')?.trim()
  const key = Deno.env.get('CONTACT_ENRICHMENT_API_KEY')?.trim()
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null
}

export function contactStoreConfigured(): boolean {
  return settings() !== null
}

export async function post<T>(
  path: string,
  body: unknown,
  timeoutMs = contactStoreTimeoutMs(),
): Promise<T> {
  const s = settings()
  if (!s) throw new ContactStoreUnavailable('not configured')
  let res: Response
  try {
    res = await fetch(`${s.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new ContactStoreUnavailable(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!res.ok) {
    let code = ''
    try {
      code =
        ((await res.json()) as { error?: { code?: string } })?.error?.code ?? ''
    } catch {
      // only for the message
    }
    throw new ContactStoreUnavailable(
      `HTTP ${res.status}${code ? ` ${code}` : ''}`,
      res.status,
      code,
    )
  }
  return (await res.json()) as T
}

/** GET /ready: true only for a 200, i.e. the store can read and write. Never throws. */
export async function contactStoreReady(
  timeoutMs = contactStoreTimeoutMs(),
): Promise<boolean> {
  const s = settings()
  if (!s) return false
  try {
    const res = await fetch(`${s.url}/ready`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.body?.cancel()
    return res.status === 200
  } catch {
    return false
  }
}

/**
 * The store's contacts (then ZipLabs', through the store) in this function's own shape. A value
 * another platform marked bad is left out. "not_found" when there is nothing usable. Throws
 * ContactStoreUnavailable when the store can't answer, ZipLabs being down included: the caller then
 * goes on to SalesQL exactly as before.
 */
export async function contactStoreLookup(
  linkedinUrl: string,
  kinds: ContactKind[] = ['email', 'phone'],
): Promise<
  VendorResult & { pending?: ContactKind[]; retryAfterMs?: number | null }
> {
  const body = await post<{
    emails?: StoreContact[]
    phones?: StoreContact[]
    pending?: unknown
    retry_after_ms?: unknown
  }>('/v1/contacts/lookup', {
    linkedin_url: linkedinUrl,
    kinds,
  })
  // A value another platform marked bad is left out, and so is a malformed
  // entry (no string value): it would otherwise be saved and break the panel.
  const usable = (items?: StoreContact[]) =>
    (Array.isArray(items) ? items : []).filter(
      (c) =>
        !!c &&
        typeof c.value === 'string' &&
        c.value.trim() !== '' &&
        c.status !== 'bad',
    )
  const emails: ContactEmail[] = usable(body.emails).map((c) => ({
    value: c.value,
    type: null,
    status: c.verified === true ? 'Valid' : null,
  }))
  const phones: ContactPhone[] = usable(body.phones).map((c) => ({
    value: c.value,
    type: null,
    valid: c.verified,
  }))
  // ZipLabs still fetching these kinds (SHARED_CONTRACT.md §2). An older store
  // never sends it: nothing pending.
  const pending = (Array.isArray(body.pending) ? body.pending : []).filter(
    (k): k is ContactKind =>
      (k === 'email' || k === 'phone') && kinds.includes(k),
  )
  const retryAfter = Number(body.retry_after_ms)
  return {
    status: emails.length || phones.length ? 'found' : 'not_found',
    emails,
    phones,
    ...(pending.length
      ? {
          pending,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter : null,
        }
      : {}),
  }
}

/**
 * Logs a failed store call without any contact data. A 401 / 403 means Lyca's
 * key is wrong or revoked, which no retry fixes: logged as an error, so it is
 * noticed; anything else (down, slow, busy) is a warning.
 */
export function logStoreFailure(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (
    err instanceof ContactStoreUnavailable &&
    (err.status === 401 || err.status === 403)
  ) {
    console.error(
      `${label}: ${message} — the store refused Lyca's key; check CONTACT_ENRICHMENT_API_KEY`,
    )
    return
  }
  console.warn(`${label}: ${message}`)
}

/** One value as the store's POST /v1/contacts takes it. */
export interface StoreContactInput {
  kind: ContactKind
  value: string
  vendor?: string
  verified?: true
}

/** The most contacts the store takes in one POST /v1/contacts. */
export const SAVE_BATCH = 20

function withValue<T>(items: T[] | null | undefined): T[] {
  return (Array.isArray(items) ? items : []).filter((c) => {
    const value = (c as { value?: unknown } | null)?.value
    return typeof value === 'string' && value.trim() !== ''
  })
}

/**
 * What a vendor found, as the store takes it: emails then phones, a value
 * only when it is a non-empty string, `verified` only when the vendor said
 * so. `vendor` null leaves it out (a value that is not one of Lyca's vendors').
 */
export function storeContactsFrom(
  vendor: string | null,
  found: {
    emails?: Array<Partial<ContactEmail>> | null
    phones?: Array<Partial<ContactPhone>> | null
  },
): StoreContactInput[] {
  const from = vendor ? { vendor } : {}
  return [
    ...withValue(found.emails).map((e) => ({
      kind: 'email' as const,
      value: e.value as string,
      ...from,
      ...(e.status === 'Valid' || e.status === 'deliverable'
        ? { verified: true as const }
        : {}),
    })),
    ...withValue(found.phones).map((p) => ({
      kind: 'phone' as const,
      value: p.value as string,
      ...from,
      ...(p.valid ? { verified: true as const } : {}),
    })),
  ]
}

/**
 * Saves what a vendor found, so every platform reuses it. Best-effort: logs,
 * never throws. True when the store now holds every value (or there was
 * nothing to send); false when a call failed or the store is not configured.
 */
export async function contactStoreSave(
  linkedinUrl: string,
  vendor: string,
  found: { emails: ContactEmail[]; phones: ContactPhone[] },
): Promise<boolean> {
  if (!contactStoreConfigured()) return false
  const contacts = storeContactsFrom(vendor, found)
  try {
    // The store takes at most SAVE_BATCH contacts per call.
    for (let i = 0; i < contacts.length; i += SAVE_BATCH) {
      await post(
        '/v1/contacts',
        {
          linkedin_url: linkedinUrl,
          contacts: contacts.slice(i, i + SAVE_BATCH),
        },
        BACKGROUND_TIMEOUT_MS,
      )
    }
    return true
  } catch (err) {
    logStoreFailure('contact store save skipped', err)
    return false
  }
}

/** Lyca's thumbs up / down reasons as the store's. */
export const STORE_REASON: Record<
  string,
  'not_reachable' | 'bounced' | 'wrong_person' | 'other'
> = {
  bounced: 'bounced',
  wrong_person: 'wrong_person',
  not_reachable: 'not_reachable',
  no_answer: 'not_reachable',
}

/** POST /v1/contacts/feedback's body for one 👍/👎 (a 👎 reason mapped to the store's). */
export function storeFeedbackBody(
  linkedinUrl: string,
  kind: ContactKind,
  value: string,
  verdict: 'good' | 'bad',
  reason: string | null,
  givenAt?: string | null,
) {
  const at = givenAtOf(givenAt)
  return {
    linkedin_url: linkedinUrl,
    kind,
    value,
    verdict,
    ...(verdict === 'bad'
      ? { reason: STORE_REASON[reason ?? ''] ?? 'other' }
      : {}),
    ...(at ? { given_at: at } : {}),
  }
}

/**
 * `given_at` for the store: when the 👍/👎 was saved (the feedback row's
 * updated_at), as ISO 8601 UTC. Null for anything that is not a time.
 */
export function givenAtOf(time: string | null | undefined): string | null {
  if (!time) return null
  const ms = Date.parse(time)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * POST /v1/contacts/feedback. The body carries `given_at` (the store ignores
 * a verdict older than the one it holds, and the same verdict sent twice), so
 * re-sending a 👍/👎 is harmless. A store from before `given_at` refuses the
 * unknown field (422 invalid_request): then it is sent once more without it.
 */
export async function postFeedback(
  body: ReturnType<typeof storeFeedbackBody>,
  timeoutMs = contactStoreTimeoutMs(),
): Promise<void> {
  try {
    await post('/v1/contacts/feedback', body, timeoutMs)
  } catch (err) {
    const olderStore =
      err instanceof ContactStoreUnavailable &&
      err.status === 422 &&
      err.code === 'invalid_request' &&
      'given_at' in body
    if (!olderStore) throw err
    const { given_at: _givenAt, ...withoutTime } = body
    await post('/v1/contacts/feedback', withoutTime, timeoutMs)
  }
}

/**
 * A thumbs up / down, shared with every platform. Best-effort: logs, never
 * throws. True when the store took it. `givenAt`: when it was saved.
 */
export async function contactStoreFeedback(
  linkedinUrl: string,
  kind: ContactKind,
  value: string,
  verdict: 'good' | 'bad',
  reason: string | null,
  givenAt?: string | null,
): Promise<boolean> {
  if (!contactStoreConfigured()) return false
  try {
    await postFeedback(
      storeFeedbackBody(linkedinUrl, kind, value, verdict, reason, givenAt),
      BACKGROUND_TIMEOUT_MS,
    )
    return true
  } catch (err) {
    // A 404 means the store does not hold this value (its save failed, or it
    // was looked up before the store existed): the feedback row stays
    // unsynced and the sync job saves the value, then sends the 👍/👎 again.
    logStoreFailure('contact store feedback skipped', err)
    return false
  }
}

/**
 * Runs `onSent` once `send` reports the store took everything. A failing
 * `onSent` (marking the row synced) is only logged by inBackground: the row
 * then stays unsynced and the sync job sends it again, which is harmless.
 */
async function thenMark(
  send: Promise<boolean>,
  onSent?: () => unknown,
): Promise<void> {
  if ((await send) && onSent) await onSent()
}

/**
 * contactStoreSave without waiting for it: the reveal answers straight away.
 * `onSent` runs once the store holds every value (it marks the row synced).
 */
export function contactStoreSaveLater(
  linkedinUrl: string,
  vendor: string,
  found: { emails: ContactEmail[]; phones: ContactPhone[] },
  onSent?: () => unknown,
): void {
  if (!contactStoreConfigured()) return
  inBackground(
    thenMark(contactStoreSave(linkedinUrl, vendor, found), onSent),
    'contact store save',
  )
}

/**
 * contactStoreFeedback without waiting for it: the 👍/👎 answers straight away.
 * `onSent` runs once the store took it (it marks the feedback row synced);
 * `givenAt` is when the 👍/👎 was saved (sent as the store's `given_at`).
 */
export function contactStoreFeedbackLater(
  linkedinUrl: string,
  kind: ContactKind,
  value: string,
  verdict: 'good' | 'bad',
  reason: string | null,
  onSent?: () => unknown,
  givenAt?: string | null,
): void {
  if (!contactStoreConfigured()) return
  inBackground(
    thenMark(
      contactStoreFeedback(linkedinUrl, kind, value, verdict, reason, givenAt),
      onSent,
    ),
    'contact store feedback',
  )
}
