// The contact flow's decisions (HIR-491), kept free of I/O so they can be
// tested on their own:
//
//   "Get contact" -> the shared contact store first. For each kind (email,
//                    phone) the store has nothing for, Lyca's own vendors run
//                    straight away, no click: SalesQL, then BetterContact for
//                    whatever SalesQL did not find (an empty kind has nothing
//                    to 👎, so the second vendor is asked at once). Every
//                    answer and every 👍/👎 goes back to the store. A person
//                    looked up before is only resumed: kinds that still have
//                    no value and a vendor that never answered for them (an
//                    older lookup, or a vendor error) — see kindsToResume.
//   Origin         -> where each value came from: 'store' (the shared store
//                    gave it and Lyca's own vendors never did), 'salesql' or
//                    'bettercontact'. Decided from Lyca's own rows, because
//                    the store never says who supplied a value: a store value
//                    that Lyca's SQL also holds from a vendor counts as that
//                    vendor's (SalesQL first). The dashboard only ever sees
//                    `source` ('store' | 'vendor') and `feedback`, never which
//                    vendor.
//   👍/👎           -> on store values, and on SalesQL values while
//                    BetterContact (the last vendor) has not been asked for
//                    that kind. Never on BetterContact values: nothing is left
//                    to ask after them.
//   "Find another" -> after a 👎 on a STORE value of a kind: the next vendor
//                    not yet asked for it (SalesQL, else BetterContact).
//                    After a 👎 on a SALESQL value: BetterContact, if not yet
//                    asked for that kind. Never after BetterContact. Also
//                    offered (as "Find email / number") for a kind with no
//                    value at all that a vendor never answered for.

import {
  isRateLimited,
  logStoreFailure,
  type ContactStoreUnavailable,
} from './contact-store.ts'
import { normalizePhone } from './phone.ts'
import { isInvalid } from './validity.ts'
import type {
  ContactEmail,
  ContactKind,
  ContactPhone,
  VendorResult,
} from './vendors.ts'

export interface Found {
  emails: Array<{ value: string; status?: string | null }>
  phones: Array<{ value: string; valid?: boolean | null }>
}

/** A stored value is only used when `value` is a non-empty string. */
function usableValue<T extends { value?: unknown }>(
  v: T | null | undefined,
): v is T & { value: string } {
  return !!v && typeof v.value === 'string' && v.value.trim() !== ''
}

/**
 * The row's values of one kind, malformed ones dropped: no string value, or a
 * phone the shared phone rule refuses (phone.ts; e.g. "12345"). Such a phone
 * is never shown or counted as found, so the next vendor is asked (BUG-4).
 */
function valuesOf<T extends { value?: unknown }>(
  row: { emails?: T[] | null; phones?: T[] | null } | null | undefined,
  kind: ContactKind,
): Array<T & { value: string }> {
  const list = row ? (kind === 'email' ? row.emails : row.phones) : null
  return (Array.isArray(list) ? list : [])
    .filter(usableValue)
    .filter((v) => kind !== 'phone' || normalizePhone(v.value) !== null)
}

export { isInvalid }

/** The row's values of one kind that count as found: malformed and invalid ones dropped. */
type AnyValue = { value?: unknown; status?: unknown; valid?: unknown }

export function usableValuesOf(
  row:
    | { emails?: AnyValue[] | null; phones?: AnyValue[] | null }
    | null
    | undefined,
  kind: ContactKind,
): Array<AnyValue & { value: string }> {
  return valuesOf<AnyValue>(row, kind).filter((v) => !isInvalid(kind, v))
}

/** The kinds, from those asked, that `found` has no usable value for. */
export function kindsMissing(
  found: Found | null,
  kinds: ContactKind[],
): ContactKind[] {
  return kinds.filter((kind) => !usableValuesOf(found, kind).length)
}

/**
 * How two values are compared everywhere (de-dup, "marked bad", "is it new",
 * feedback, origin): emails trimmed and lower-cased; phones in the shared
 * format (phone.ts), the text as stored when it is not a phone.
 */
export function contactId(kind: ContactKind, value: string): string {
  if (kind === 'email') return value.trim().toLowerCase()
  return normalizePhone(value) ?? value.trim()
}

/** Whether two values of a kind are the same contact. */
export function sameContact(kind: ContactKind, a: string, b: string): boolean {
  return contactId(kind, a) === contactId(kind, b)
}

/** How a value is matched to Lyca's vendor rows when deciding its origin. */
function sourceKey(kind: ContactKind, value: string): string {
  return contactId(kind, value)
}

/** What the dashboard is told: a store value, or one of Lyca's vendors'. */
export type ContactSource = 'store' | 'vendor'
/** Where a value came from, server-side only. */
export type ContactOrigin = 'store' | 'salesql' | 'bettercontact'

/** One stored value, as the candidate_contact_lookups row holds it. */
export interface StoredContact {
  value: string
  type: string | null
  status?: string | null
  valid?: boolean | null
}

export interface StoredRow {
  emails: StoredContact[]
  phones: StoredContact[]
  /** Row status ('found' | 'not_found' | 'pending' | 'error'). */
  status?: string | null
  /** BetterContact: which kinds it has answered for. The contact_store row,
   * with CONTACT_VENDORS_VIA_SERVICE on: which kinds every source of the
   * service's order was asked for (via-service.ts). */
  email_searched?: boolean | null
  phone_searched?: boolean | null
  /** BetterContact: the kinds a search still running asked for. The
   * contact_store row, with CONTACT_VENDORS_VIA_SERVICE on: the kinds the
   * service was still fetching (its `pending`). */
  pending_kinds?: ContactKind[] | null
  /** Why the last call failed (a vendor's, or the contact service's). */
  error?: string | null
  /** BetterContact: its request id. */
  vendor_request_id?: string | null
  /** The contact_store row, with CONTACT_VENDORS_VIA_SERVICE on: when the
   * service's `pending` began (via-service.ts; migration 20261104000001). */
  pending_since?: string | null
  /** The contact_store row, with CONTACT_VENDORS_VIA_SERVICE on: per kind,
   * the source the service named (via-service.ts; migration 20261104000002).
   * Server-side only. */
  found_in_by_kind?: Partial<Record<ContactKind, string>> | null
  /** The contact_store row, with CONTACT_VENDORS_VIA_SERVICE on: when
   * email_searched / phone_searched was set (via-service.ts; migration
   * 20261104000003). The flag counts for SERVICE_SEARCHED_MAX_AGE_MS. */
  email_searched_at?: string | null
  phone_searched_at?: string | null
}

/**
 * How long the contact service's "every source was asked, nothing found" for
 * a kind stands: 30 days, the service's own recheck period for a vendor's
 * answer (contact-enrichment VENDOR_RECHECK_DAYS). After that the kind is
 * unanswered again, so a wrong "not found" (a vendor the service skipped
 * without saying so: contact-enrichment #20) does not last for ever.
 */
export const SERVICE_SEARCHED_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/** When the contact_store row's flag for this kind was set (ms), or null when it holds no time. */
export function serviceSearchedAt(
  row: StoredRow | null | undefined,
  kind: ContactKind,
): number | null {
  const raw = kind === 'email' ? row?.email_searched_at : row?.phone_searched_at
  if (typeof raw !== 'string' || !raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The contact service already asked every source of Lyca's order for this
 * kind and found nothing (the contact_store row's email_searched /
 * phone_searched, written only while CONTACT_VENDORS_VIA_SERVICE was on),
 * within the last SERVICE_SEARCHED_MAX_AGE_MS. With the setting off again,
 * such a kind is not bought from SalesQL or BetterContact a second time
 * (HIR-537 review). A flag with no time (a row written before migration
 * 20261104000003, or read without that column) still counts: nothing says it
 * is old, and counting it never pays a vendor.
 */
export function serviceSearched(
  rows: PersonRows,
  kind: ContactKind,
  now: number = Date.now(),
): boolean {
  const flag =
    kind === 'email' ? rows.shared?.email_searched : rows.shared?.phone_searched
  if (!flag) return false
  const at = serviceSearchedAt(rows.shared, kind)
  return at === null || now - at <= SERVICE_SEARCHED_MAX_AGE_MS
}

/** The person's rows in Lyca's SQL, by where they came from. */
export interface PersonRows {
  /** vendor 'contact_store' — what the shared store returned. */
  shared?: StoredRow | null
  salesql?: StoredRow | null
  bettercontact?: StoredRow | null
}

function holds(
  row: StoredRow | null | undefined,
  kind: ContactKind,
  id: string,
): boolean {
  return valuesOf(row, kind).some((v) => sourceKey(kind, v.value) === id)
}

/** Where a value of this person came from (see the header). */
export function originOf(
  kind: ContactKind,
  value: string,
  rows: PersonRows,
): ContactOrigin {
  const id = sourceKey(kind, value)
  if (holds(rows.salesql, kind, id)) return 'salesql'
  if (holds(rows.bettercontact, kind, id)) return 'bettercontact'
  return 'store'
}

/** 'store' or 'vendor' — all the dashboard is told about a value's origin. */
export function sourceOf(
  kind: ContactKind,
  value: string,
  rows: PersonRows,
): ContactSource {
  return originOf(kind, value, rows) === 'store' ? 'store' : 'vendor'
}

/** BetterContact has answered for this kind, or a search of it is running. */
export function backupAskedFor(kind: ContactKind, rows: PersonRows): boolean {
  const row = rows.bettercontact
  if (!row) return false
  if (kind === 'email' ? row.email_searched : row.phone_searched) return true
  // (A request from before per-kind searches asked for both.)
  return (
    row.status === 'pending' &&
    (row.pending_kinds ?? ['email', 'phone']).includes(kind)
  )
}

/** Whether a value takes 👍/👎 (see the header). */
export function takesFeedback(
  kind: ContactKind,
  value: string,
  rows: PersonRows,
): boolean {
  const origin = originOf(kind, value, rows)
  if (origin === 'store') return true
  if (origin === 'salesql') return !backupAskedFor(kind, rows)
  return false
}

export interface ContactItem {
  value: string
  type: string | null
  verified: boolean | null
  verdict: 'good' | 'bad' | null
  reason: string | null
  /** 'store' or 'vendor'; never which vendor. */
  source: ContactSource
  /** Whether 👍/👎 is shown for this value (decided here, see the header). */
  feedback: boolean
  /** Its own vendor said it is bad (isInvalid): shown as such, hidden when a usable one exists. */
  invalid: boolean
}

/**
 * One list per kind for the dashboard: store values first, then SalesQL,
 * then BetterContact, duplicates and malformed values dropped. Every value
 * carries its source and whether it takes 👍/👎; which vendor it was is
 * never sent.
 */
export function mergeContacts(
  kind: ContactKind,
  rows: PersonRows,
  verdictOf: (
    value: string,
  ) => { verdict: 'good' | 'bad'; reason: string | null } | null,
): ContactItem[] {
  const seen = new Set<string>()
  const items: ContactItem[] = []
  for (const row of [rows.shared, rows.salesql, rows.bettercontact]) {
    for (const raw of valuesOf(row, kind)) {
      const id = contactId(kind, raw.value)
      if (seen.has(id)) continue
      seen.add(id)
      const f = verdictOf(raw.value)
      const status = raw.status ?? null
      items.push({
        value: raw.value,
        type: raw.type ?? null,
        verified:
          'valid' in raw
            ? (raw.valid ?? null)
            : status === 'Valid' || status === 'deliverable'
              ? true
              : status === 'Invalid' || status === 'undeliverable'
                ? false
                : null,
        verdict: f?.verdict ?? null,
        reason: f?.reason ?? null,
        source: sourceOf(kind, raw.value, rows),
        feedback: takesFeedback(kind, raw.value, rows),
        invalid: isInvalid(kind, raw),
      })
    }
  }
  // A value its vendor called invalid is only shown while nothing better exists.
  const better = items.some((x) => !x.invalid && x.verdict !== 'bad')
  return better ? items.filter((x) => !x.invalid) : items
}

/** The values of a kind, by origin, as canFindAnother takes them. */
export function valuesByOrigin(
  kind: ContactKind,
  items: Array<{ value: string }>,
  rows: PersonRows,
): { storeValues: Set<string>; salesqlValues: Set<string> } {
  const storeValues = new Set<string>()
  const salesqlValues = new Set<string>()
  for (const item of items) {
    const origin = originOf(kind, item.value, rows)
    if (origin === 'store') storeValues.add(contactId(kind, item.value))
    if (origin === 'salesql') salesqlValues.add(contactId(kind, item.value))
  }
  return { storeValues, salesqlValues }
}

/** The store's lookup answer: the values, plus the kinds ZipLabs is still fetching. */
export interface StoreAnswer extends VendorResult {
  /** Kinds a paid ZipLabs fetch is still running for (contact-enrichment docs/SHARED_CONTRACT.md §2). */
  pending?: ContactKind[]
  /** When to ask again, with `pending`. */
  retryAfterMs?: number | null
}

/** A `pending` kind is waited for at most this long before asking again (once). */
export const PENDING_WAIT_MAX_MS = 5_000
/** The wait when a `pending` answer has no usable `retry_after_ms`. */
export const PENDING_WAIT_DEFAULT_MS = 1_000

/**
 * The one rule for `pending`, for the store's lookup (storeFirst) and the
 * contact service's answers (via-service.ts, askWithPending): call once; when
 * the answer says a kind asked for is still being fetched, wait its
 * `retry_after_ms` (1 s when absent, at most 5 s, never past the request's
 * deadline) and call once more. Returns the first answer and the second (null
 * when there was no second call, or it failed: that failure is logged). The
 * first call's failure is thrown.
 */
export async function askTwiceIfPending<T>(
  call: () => Promise<T>,
  pendingOf: (answer: T) => { pending: boolean; retryAfterMs: unknown },
  options: {
    sleep?: (ms: number) => Promise<void>
    deadline?: { cap(ms: number): number }
    /** For the log line when the second call fails. */
    label: string
  },
): Promise<{ first: T; again: T | null }> {
  const first = await call()
  const { pending, retryAfterMs } = pendingOf(first)
  if (!pending) return { first, again: null }
  const after = Number(retryAfterMs)
  const ms = Math.min(
    Number.isFinite(after) && after >= 0 ? after : PENDING_WAIT_DEFAULT_MS,
    PENDING_WAIT_MAX_MS,
  )
  await (options.sleep ?? wait)(options.deadline?.cap(ms) ?? ms)
  try {
    return { first, again: await call() }
  } catch (err) {
    logStoreFailure(
      `${options.label} re-ask failed, using the first answer`,
      err,
    )
    return { first, again: null }
  }
}

export interface StoreFirstOptions {
  /** How to wait for `retry_after_ms` (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
  /** Called when the store could not answer (down, slow, an error answer, rate limited). */
  onUnavailable?: (err: unknown) => void
  /** The request's deadline: the `pending` wait is cut to what is left. */
  deadline?: { cap(ms: number): number }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * "Get contact": the shared store first, then which kinds Lyca's vendors must
 * run for. Any store failure (down, slow, an error answer) is swallowed and
 * every kind goes to the vendors — a reveal never shows a store error.
 *
 * A kind the store answers as `pending` (ZipLabs still fetching it) is not
 * bought from a vendor yet: wait `retry_after_ms` (at most 5 s), ask once more,
 * and only what is then still missing (pending or not) goes to the vendors.
 *
 * A 429 (`rate_limited`: Lyca sent the service too many requests this minute)
 * is the exception: the service is up, so Lyca's own vendors do NOT stand in
 * for it, or hitting the limit would mean more vendor spend. Nothing is left
 * for the vendors (`missing` empty), `rateLimited` is set, and onUnavailable
 * is called, so the caller records it like an outage ("temporarily
 * unavailable, try again", nothing final). The same holds when only the
 * second ask (after `pending`) is rate limited.
 */
export async function storeFirst(
  lookup: () => Promise<StoreAnswer>,
  kinds: ContactKind[],
  options: StoreFirstOptions = {},
): Promise<{
  fromStore: VendorResult | null
  missing: ContactKind[]
  rateLimited?: true
}> {
  // The 429 of either ask, if any (the second ask's failure is swallowed by
  // askTwiceIfPending, so it is noted here).
  const limit: { err: ContactStoreUnavailable | null } = { err: null }
  const call = async () => {
    try {
      return await lookup()
    } catch (err) {
      if (isRateLimited(err)) limit.err = err
      throw err
    }
  }
  const rateLimitedAnswer = (
    err: ContactStoreUnavailable,
    fromStore: VendorResult | null,
  ) => {
    console.warn(
      `contact store rate limited (HTTP ${err.status}${err.code ? ` ${err.code}` : ''}, Retry-After: ${err.retryAfter || 'not sent'}): Lyca's own vendors not called; the panel says "temporarily unavailable"`,
    )
    options.onUnavailable?.(err)
    return {
      fromStore,
      missing: [] as ContactKind[],
      rateLimited: true as const,
    }
  }
  let asked: { first: StoreAnswer; again: StoreAnswer | null }
  try {
    asked = await askTwiceIfPending(
      call,
      (a) => ({
        pending: (Array.isArray(a.pending) ? a.pending : []).some((k) =>
          kinds.includes(k),
        ),
        retryAfterMs: a.retryAfterMs,
      }),
      {
        sleep: options.sleep,
        deadline: options.deadline,
        label: 'contact store',
      },
    )
  } catch (err) {
    if (isRateLimited(err)) return rateLimitedAnswer(err, null)
    logStoreFailure('contact store unavailable, using the vendors', err)
    options.onUnavailable?.(err)
    return { fromStore: null, missing: kinds }
  }
  const { first, again } = asked
  // The second answer is the newer one; the first stands if it says less.
  const answer =
    again && (again.status === 'found' || first.status !== 'found')
      ? again
      : first
  // Only the second ask was rate limited: what the first brought is kept.
  if (limit.err) {
    return rateLimitedAnswer(
      limit.err,
      answer.status === 'found' ? answer : null,
    )
  }
  if (answer.status !== 'found') return { fromStore: null, missing: kinds }
  return { fromStore: answer, missing: kindsMissing(answer, kinds) }
}

export const STORE_UNREACHABLE = 'The contact store could not be reached.'

/**
 * The person's contact_store row after asking the store (index.ts askStore):
 * what it held plus what the store gave now (no duplicates). 'found' with any
 * value; 'error' when the store could not answer (down, slow, rate limited)
 * and nothing is held: the store was not really asked, so the panel says
 * "temporarily unavailable" and the next "Get contact" asks it again; else
 * 'not_found'. Null: nothing to change (the store could not answer and the
 * row already holds values).
 */
export function storeRowAfterAsk(
  existing:
    | {
        status: VendorResult['status']
        emails?: ContactEmail[] | null
        phones?: ContactPhone[] | null
      }
    | null
    | undefined,
  got: VendorResult | null,
  unavailable: boolean,
): VendorResult | null {
  if (unavailable && existing && existing.status === 'found' && !got) {
    return null
  }
  const add = <T extends { value: string }>(
    kind: ContactKind,
    held: T[] | null | undefined,
    fresh: T[] | null | undefined,
  ): T[] => {
    const out = [...(Array.isArray(held) ? held : [])]
    for (const v of Array.isArray(fresh) ? fresh : []) {
      if (!out.some((x) => sameContact(kind, x.value, v.value))) out.push(v)
    }
    return out
  }
  const emails = add('email', existing?.emails, got?.emails)
  const phones = add('phone', existing?.phones, got?.phones)
  const status: VendorResult['status'] =
    emails.length || phones.length
      ? 'found'
      : unavailable
        ? 'error'
        : 'not_found'
  return {
    status,
    emails,
    phones,
    error: status === 'error' ? STORE_UNREACHABLE : null,
  }
}

export interface VendorsLeft {
  /** SalesQL has answered for this person (found / not found, not an error). */
  salesqlAsked: boolean
  salesqlReady: boolean
  backupReady: boolean
}

/**
 * A person looked up before: the kinds that still have no value at all and
 * that a configured vendor never answered for — an older lookup (SalesQL
 * found only an email, BetterContact never asked for the phone) or a vendor
 * that errored. Those are searched again; nothing else is re-bought.
 */
export function kindsToResume(
  rows: PersonRows,
  kinds: ContactKind[],
  left: VendorsLeft,
): ContactKind[] {
  return kinds.filter((kind) => {
    if (hasUsable(rows, kind)) return false
    return (
      (left.salesqlReady && !left.salesqlAsked) ||
      (left.backupReady && !backupAskedFor(kind, rows))
    )
  })
}

/** Any source holds a usable value of this kind (invalid ones do not count). */
function hasUsable(rows: PersonRows, kind: ContactKind): boolean {
  return [rows.shared, rows.salesql, rows.bettercontact].some(
    (row) => usableValuesOf(row, kind).length > 0,
  )
}

/**
 * Whether the shared store was really asked for this person: its answer is
 * recorded as the contact_store row (found / not_found). No row (a lookup from
 * before the store, or with the store unset) or status 'error' (the store was
 * down or slow) means it was not.
 */
export function storeAsked(rows: PersonRows): boolean {
  const status = rows.shared?.status
  return !!rows.shared && status !== 'error'
}

/**
 * The kinds to ask the store for before any paid vendor on a later "Get
 * contact" (HIR-528): kinds with no usable value, while the store was never
 * really asked for this person.
 */
export function kindsForStore(
  rows: PersonRows,
  kinds: ContactKind[],
  storeReady: boolean,
): ContactKind[] {
  if (!storeReady || storeAsked(rows)) return []
  return kinds.filter((kind) => !hasUsable(rows, kind))
}

/**
 * A kind with nothing usable while a source failed (the store down, a vendor
 * error): "temporarily unavailable, try again", never a final "not found".
 */
export function kindUnavailable(rows: PersonRows, kind: ContactKind): boolean {
  if (hasUsable(rows, kind)) return false
  return [rows.shared, rows.salesql, rows.bettercontact].some(
    (row) => row?.status === 'error',
  )
}

export interface FindAnotherInput {
  kind: ContactKind
  /** Every value of this kind shown, with the workspace's verdict. */
  items: Array<{ value: string; verdict: 'good' | 'bad' | null }>
  /** Values of this kind whose origin is the shared store (not a Lyca vendor). */
  storeValues: Set<string>
  /** Values of this kind SalesQL found (contactId form). */
  salesqlValues?: Set<string>
  /** SalesQL has already been asked for this person (an answer, not an error). */
  salesqlAsked: boolean
  /** BetterContact has already been asked for this kind. */
  backupAsked: boolean
  salesqlReady: boolean
  backupReady: boolean
}

/** Whether "Find another email / number" is offered for this kind. */
export function canFindAnother(input: FindAnotherInput): boolean {
  const badIn = (values: Set<string> | undefined) =>
    !!values &&
    input.items.some(
      (item) =>
        item.verdict === 'bad' && values.has(contactId(input.kind, item.value)),
    )
  const backupLeft = input.backupReady && !input.backupAsked
  // 👎 on a store value: the next vendor not yet asked (SalesQL, else BetterContact).
  if (badIn(input.storeValues)) {
    return (input.salesqlReady && !input.salesqlAsked) || backupLeft
  }
  // 👎 on a SalesQL value: BetterContact, the last vendor.
  if (badIn(input.salesqlValues)) return backupLeft
  // 👎 on a BetterContact value (or no 👎): nothing.
  return false
}
