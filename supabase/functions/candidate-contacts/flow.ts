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

import { logStoreFailure } from './contact-store.ts'
import { normalizePhone } from './phone.ts'
import type { ContactKind, VendorResult } from './vendors.ts'

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

/** The row's values of one kind, malformed ones (no string value) dropped. */
function valuesOf<T extends { value?: unknown }>(
  row: { emails?: T[] | null; phones?: T[] | null } | null | undefined,
  kind: ContactKind,
): Array<T & { value: string }> {
  const list = row ? (kind === 'email' ? row.emails : row.phones) : null
  return (Array.isArray(list) ? list : []).filter(usableValue)
}

/**
 * A value its own vendor said is bad (HIR-528): a SalesQL email with status
 * "Invalid" (or a BetterContact "undeliverable"), a phone with is_valid false.
 * It does not count as found: the next vendor is asked for that kind.
 */
export function isInvalid(
  kind: ContactKind,
  v: { status?: unknown; valid?: unknown } | null | undefined,
): boolean {
  if (!v) return false
  if (kind === 'phone') return v.valid === false
  const status = typeof v.status === 'string' ? v.status.toLowerCase() : ''
  return status === 'invalid' || status === 'undeliverable'
}

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
  /** BetterContact only: which kinds it has answered for. */
  email_searched?: boolean | null
  phone_searched?: boolean | null
  /** BetterContact only: the kinds a search still running asked for. */
  pending_kinds?: ContactKind[] | null
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
  /** Kinds a paid ZipLabs fetch is still running for (SHARED_CONTRACT.md §2). */
  pending?: ContactKind[]
  /** When to ask again, with `pending`. */
  retryAfterMs?: number | null
}

/** A `pending` kind is waited for at most this long before asking again (once). */
export const PENDING_WAIT_MAX_MS = 5_000
const PENDING_WAIT_DEFAULT_MS = 1_000

export interface StoreFirstOptions {
  /** How to wait for `retry_after_ms` (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
  /** Called when the store could not answer (down, slow, an error answer). */
  onUnavailable?: (err: unknown) => void
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
 */
export async function storeFirst(
  lookup: () => Promise<StoreAnswer>,
  kinds: ContactKind[],
  options: StoreFirstOptions = {},
): Promise<{ fromStore: VendorResult | null; missing: ContactKind[] }> {
  let answer: StoreAnswer
  try {
    answer = await lookup()
  } catch (err) {
    logStoreFailure('contact store unavailable, using the vendors', err)
    options.onUnavailable?.(err)
    return { fromStore: null, missing: kinds }
  }
  const pending = (Array.isArray(answer.pending) ? answer.pending : []).filter(
    (k) => kinds.includes(k),
  )
  if (pending.length) {
    const after = Number(answer.retryAfterMs)
    const ms =
      Number.isFinite(after) && after >= 0 ? after : PENDING_WAIT_DEFAULT_MS
    await (options.sleep ?? wait)(Math.min(ms, PENDING_WAIT_MAX_MS))
    try {
      const again = await lookup()
      // The second answer is the newer one; the first stands if it says less.
      if (again.status === 'found' || answer.status !== 'found') answer = again
    } catch (err) {
      logStoreFailure(
        'contact store re-ask failed, using the first answer',
        err,
      )
    }
  }
  if (answer.status !== 'found') return { fromStore: null, missing: kinds }
  return { fromStore: answer, missing: kindsMissing(answer, kinds) }
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
