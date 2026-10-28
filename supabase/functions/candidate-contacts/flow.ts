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

import type { ContactKind, VendorResult } from './vendors.ts'

export interface Found {
  emails: Array<{ value: string }>
  phones: Array<{ value: string }>
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

/** The kinds, from those asked, that `found` has no value for. */
export function kindsMissing(
  found: Found | null,
  kinds: ContactKind[],
): ContactKind[] {
  return kinds.filter((kind) => !valuesOf(found, kind).length)
}

/** How a value is compared: emails ignore case, phones are taken as stored. */
export function contactId(kind: ContactKind, value: string): string {
  return kind === 'email' ? value.trim().toLowerCase() : value.trim()
}

/**
 * How a value is matched to Lyca's vendor rows when deciding its origin:
 * emails ignore case, phones compare digits only (the store may format a
 * number differently from the vendor that found it).
 */
function sourceKey(kind: ContactKind, value: string): string {
  return kind === 'email'
    ? value.trim().toLowerCase()
    : value.replace(/[^\d]/g, '') || value.trim()
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
      })
    }
  }
  return items
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

/**
 * "Get contact": the shared store first, then which kinds Lyca's vendors must
 * run for. Any store failure (down, slow, an error answer) is swallowed and
 * every kind goes to the vendors — a reveal never shows a store error.
 */
export async function storeFirst(
  lookup: () => Promise<VendorResult>,
  kinds: ContactKind[],
): Promise<{ fromStore: VendorResult | null; missing: ContactKind[] }> {
  try {
    const fromStore = await lookup()
    if (fromStore.status !== 'found') return { fromStore: null, missing: kinds }
    return { fromStore, missing: kindsMissing(fromStore, kinds) }
  } catch (err) {
    console.warn(
      'contact store unavailable, using the vendors:',
      err instanceof Error ? err.message : String(err),
    )
    return { fromStore: null, missing: kinds }
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
    const anyValue = [rows.shared, rows.salesql, rows.bettercontact].some(
      (row) => valuesOf(row, kind).length > 0,
    )
    if (anyValue) return false
    return (
      (left.salesqlReady && !left.salesqlAsked) ||
      (left.backupReady && !backupAskedFor(kind, rows))
    )
  })
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
