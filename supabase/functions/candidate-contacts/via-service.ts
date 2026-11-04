// Lyca's reveal through the shared contact service (HIR-537; decision HIR-461:
// the service makes every contact vendor call).
//
// The setting: CONTACT_VENDORS_VIA_SERVICE, a function secret on the Lyca
// project. Only the exact text "true" turns it on; unset (the default) or
// anything else is off, and off is exactly the reveal of HIR-491 / HIR-528
// (index.ts, flow.ts: the store, then Lyca's own SalesQL and BetterContact).
// Turning it on or back off is a secret change, never a code deploy. Lyca's
// vendor code stays (vendors.ts), because switching back needs it.
//
// With it on, Lyca calls no vendor itself:
//   "Get contact"  -> ONE POST /v1/contacts/lookup, without `ziplabs: false`,
//                     so the service runs Lyca's order (the store, then
//                     SalesQL, BetterContact, ZipLabs last: the service's
//                     WATERFALLS). A kind in `pending` is waited for
//                     (`retry_after_ms`, at most 5 s) and asked once more.
//   "Find another" -> POST /v1/contacts/find-another { linkedin_url, kind,
//                     shown } after a 👎. `exhausted: true` means every source
//                     was asked: "No other email / number found". With both
//                     kinds wanted, the second is asked only if the request
//                     still has time for it (the panel keeps offering it).
//   `has: false`   -> "every source was asked" ONLY when the answer carries
//                     `found_in_by_kind`, which the service sends only to a
//                     product in its WATERFALLS (HIR-537 review). Without it
//                     (Lyca not yet, or no longer, in WATERFALLS: the cutover)
//                     the service ran no vendor, so the kind is left
//                     unanswered ("temporarily unavailable", "Try again"),
//                     never a final "not found".
//   👍/👎            -> unchanged: saved in Lyca's table and sent to the store
//                     (POST /v1/contacts/feedback, contact-store.ts).
//   An outage      -> any failure (503 vendors_unavailable / store_unavailable,
//                     a timeout, a refused key) is "temporarily unavailable,
//                     try again" and nothing final is recorded: never "not
//                     found". So is a kind the answer lists in `unavailable`
//                     (a vendor for it was down, timed out or refused): it is
//                     not marked as searched, and the next "Get contact",
//                     "Try again" or re-check asks for it again.
//   Re-check       -> the panel re-checks (8 s apart) only while a kind is
//                     `pending`, and only the pending kinds (never a kind
//                     whose vendors were unavailable: that could make the
//                     service pay without a click). A pending kind stops
//                     being re-checked PENDING_RECHECK_MAX_MS (60 s) after
//                     it began: it then shows "temporarily unavailable" with
//                     "Try again", which starts a new window.
// The wait is CONTACT_ENRICHMENT_TIMEOUT_MS, at least 25 s while on (the
// service's own worst case is about 22 s), and never past the request's
// deadline (deadline.ts): every call, and the `pending` wait, gets only what
// is left.
//
// name / company: sent (cut to the service's 200 characters) so the service
// can give them to BetterContact. A service without them (before
// contact-enrichment #19) refuses unknown fields with 422 "property name
// should not exist": the call is then made again without them, and they are
// left out for PERSON_FIELDS_RETRY_MS before being tried again. So Lyca works
// against the service both before and after #19.
//
// What is kept: the answer is Lyca's `contact_store` row in
// candidate_contact_lookups, as before. Its values are what the service
// returned that is not marked bad. Each email also keeps the service's email
// check result (`check`: valid / invalid / unknown); Lyca runs no check of its
// own and hides nothing because of it. Some of the row's columns get a
// meaning for this row while on: email_searched / phone_searched = every
// source was asked for that kind (nothing more to find; honoured with the
// setting off too, so switching back never re-buys it: index.ts),
// pending_kinds = the kinds the service was still fetching, and pending_since
// (migration 20261104000001) = when that began. `error` says a call failed or
// a kind's vendors were unavailable. found_in_by_kind (migration
// 20261104000002) = per kind, the source the service's latest answer for it
// named (its `found_in_by_kind`: store, a vendor, or none), for Lyca's own
// records and spend reconciliation; it never goes to the browser (index.ts
// viewsFor builds the panel's payload field by field).
//
// Kept free of Supabase so it can be tested on its own (via-service_test.ts):
// index.ts gives it the person's rows and a way to write the row.

import {
  ContactStoreUnavailable,
  contactStoreConfigured,
  kindsIn,
  logStoreFailure,
  post,
  usableWire,
  type WireContact,
} from './contact-store.ts'
import {
  askTwiceIfPending,
  kindsToResume,
  kindUnavailable,
  mergeContacts,
  sameContact,
  usableValuesOf,
  type ContactItem,
  type PersonRows,
  type StoredContact,
} from './flow.ts'
import { NO_DEADLINE, type Deadline } from './deadline.ts'
import type { ContactKind } from './vendors.ts'

/** The function secret that sends every vendor call through the service. */
export const VIA_SERVICE_SETTING = 'CONTACT_VENDORS_VIA_SERVICE'

/** True only for CONTACT_VENDORS_VIA_SERVICE=true; unset or anything else is off. */
export function contactVendorsViaService(): boolean {
  return Deno.env.get(VIA_SERVICE_SETTING)?.trim().toLowerCase() === 'true'
}

/**
 * The least a reveal waits for the service while on: its order takes a vendor
 * timeout per slot. Its own worst case is about 22 s (5 + 8 + 2 + 4 s, plus up
 * to 3 s for the email check), so 25 s.
 */
export const VIA_SERVICE_MIN_TIMEOUT_MS = 25_000

/** CONTACT_ENRICHMENT_TIMEOUT_MS, raised to at least 25 s (unset: 25 s). */
export function viaServiceTimeoutMs(): number {
  const raw = Number(Deno.env.get('CONTACT_ENRICHMENT_TIMEOUT_MS')?.trim())
  const set = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  return Math.max(set, VIA_SERVICE_MIN_TIMEOUT_MS)
}

const KINDS: ContactKind[] = ['email', 'phone']

/** The service's email check, a fixed contract on every email it returns. */
export type EmailCheck = 'valid' | 'invalid' | 'unknown'

/** One email as Lyca keeps it, with the service's check result. */
export interface ServiceEmail {
  value: string
  type: string | null
  status: string | null
  check: EmailCheck | null
}

export interface ServicePhone {
  value: string
  type: string | null
  valid: boolean | null
}

/** A lookup or find-another answer, values marked bad left out. */
export interface ServiceAnswer {
  emails: ServiceEmail[]
  phones: ServicePhone[]
  /** Per kind asked for: a usable value (find-another: a new one). */
  has: Partial<Record<ContactKind, boolean>>
  /** Kinds the service is still fetching. */
  pending: ContactKind[]
  retryAfterMs: number | null
  /** find-another only: every source of Lyca's order was asked. */
  exhausted?: boolean
  /** Kinds asked for with no usable value because a vendor for them was down, timed out or refused (absent: none). */
  unavailable?: ContactKind[]
  /**
   * The answer carries `found_in_by_kind`: the service ran Lyca's order (Lyca
   * is in its WATERFALLS). Only then does `has: false` mean every source was
   * asked.
   */
  waterfall: boolean
  /**
   * The service's `found_in_by_kind`, per kind asked for: the source that
   * answered it (`store`, a vendor such as `salesql`, or `none`). Kept on
   * Lyca's row for its own records and spend reconciliation; never sent to
   * the browser. Empty when the answer has none.
   */
  foundInByKind: FoundInByKind
}

/** Per kind, the source the contact service named for it (`store`, a vendor, or `none`). */
export type FoundInByKind = Partial<Record<ContactKind, string>>

/** A source name as the service sends it (store | contactout | salesql | bettercontact | ziplabs | none, or a vendor added later). */
const SOURCE_NAME = /^[a-z][a-z0-9_-]{0,39}$/

/** `found_in_by_kind` for `kinds` only, each a plain source name; anything else is left out. */
export function foundInByKindOf(
  raw: unknown,
  kinds: ContactKind[],
): FoundInByKind {
  const out: FoundInByKind = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const wire = raw as Record<string, unknown>
  for (const kind of kinds) {
    const source = wire[kind]
    if (typeof source === 'string' && SOURCE_NAME.test(source)) {
      out[kind] = source
    }
  }
  return out
}

function checkOf(c: WireContact): EmailCheck | null {
  const result = c.check?.result
  return result === 'valid' || result === 'invalid' || result === 'unknown'
    ? result
    : null
}

/** The service's answer in Lyca's shape. A value marked bad, or without a string value, is left out. */
export function parseServiceAnswer(
  body: unknown,
  kinds: ContactKind[],
): ServiceAnswer {
  const b = (body ?? {}) as Record<string, unknown>
  // The same filter as the store's lookup (contact-store.ts, usableWire).
  const usable = usableWire
  const emails: ServiceEmail[] = usable(b.emails).map((c) => ({
    value: c.value,
    type: null,
    status: c.verified === true ? 'Valid' : null,
    check: checkOf(c),
  }))
  const phones: ServicePhone[] = usable(b.phones).map((c) => ({
    value: c.value,
    type: null,
    valid: typeof c.verified === 'boolean' ? c.verified : null,
  }))
  const pending = kindsIn(b.pending, kinds)
  const unavailable = kindsIn(b.unavailable, kinds)
  const wireHas = (b.has ?? {}) as Record<string, unknown>
  const has: Partial<Record<ContactKind, boolean>> = {}
  for (const kind of kinds) {
    has[kind] =
      typeof wireHas[kind] === 'boolean'
        ? (wireHas[kind] as boolean)
        : usableValuesOf({ emails, phones }, kind).length > 0
  }
  const retry = Number(b.retry_after_ms)
  return {
    emails,
    phones,
    has,
    pending,
    retryAfterMs: pending.length && Number.isFinite(retry) ? retry : null,
    waterfall:
      typeof b.found_in_by_kind === 'object' && b.found_in_by_kind !== null,
    foundInByKind: foundInByKindOf(b.found_in_by_kind, kinds),
    ...(unavailable.length ? { unavailable } : {}),
    ...(typeof b.exhausted === 'boolean' ? { exhausted: b.exhausted } : {}),
  }
}

/**
 * The person a call is about. `name` and `company` are what Lyca sends
 * BetterContact today (vendors.ts: the candidate's name and employer); the
 * service passes them to BetterContact only and never stores them.
 */
export interface ServicePerson {
  linkedinUrl: string
  name?: string | null
  company?: string | null
}

/** A profile URL alone, or the person with name and company. */
export type PersonInput = string | ServicePerson

/** The name as BetterContact gets it from Lyca (vendors.ts splitName), as one string. */
export function cleanName(full: string | null | undefined): string {
  return (full ?? '')
    .replace(/[^\p{L}\p{M}\s'.-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** The service's cap on `name` and `company` (contacts.dto.ts, MaxLength(200)). */
export const PERSON_FIELD_MAX = 200

/** `text` cut to PERSON_FIELD_MAX UTF-16 units (as the service counts), never half a character. */
function capped(text: string): string {
  if (text.length <= PERSON_FIELD_MAX) return text
  let out = text.slice(0, PERSON_FIELD_MAX)
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
  return out.trim()
}

/** linkedin_url, plus `name` / `company` when not empty, each cut to 200 characters. */
export function personFields(person: PersonInput): {
  linkedin_url: string
  name?: string
  company?: string
} {
  const p = typeof person === 'string' ? { linkedinUrl: person } : person
  const name = capped(cleanName(p.name))
  const company = capped((p.company ?? '').trim())
  return {
    linkedin_url: p.linkedinUrl,
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
  }
}

/** After the service refused name / company, they are left out this long before being tried again. */
export const PERSON_FIELDS_RETRY_MS = 10 * 60_000
let personFieldsRefusedAt: number | null = null

/** Tests: forget that the service refused name / company. */
export function resetPersonFieldsSupport(): void {
  personFieldsRefusedAt = null
}

/** The service's 422 for a field it does not know (before contact-enrichment #19). */
function refusesPersonFields(err: unknown): boolean {
  return (
    err instanceof ContactStoreUnavailable &&
    err.status === 422 &&
    /property (name|company) should not exist/.test(err.detail)
  )
}

/**
 * One POST about a person: with name / company while the service takes them;
 * on its 422 for those fields, once more without them (and without them for
 * PERSON_FIELDS_RETRY_MS). A call with no time left is not made (an outage).
 */
async function postAboutPerson(
  path: string,
  person: PersonInput,
  rest: Record<string, unknown>,
  deadline: Deadline,
): Promise<unknown> {
  const timeout = () => {
    const ms = deadline.cap(viaServiceTimeoutMs())
    if (ms <= 0) throw new ContactStoreUnavailable('out of time')
    return ms
  }
  const full = personFields(person)
  const bare = { linkedin_url: full.linkedin_url, ...rest }
  const hasPerson = 'name' in full || 'company' in full
  const refusedLately =
    personFieldsRefusedAt !== null &&
    Date.now() - personFieldsRefusedAt < PERSON_FIELDS_RETRY_MS
  if (!hasPerson || refusedLately) return await post(path, bare, timeout())
  try {
    const answer = await post(path, { ...full, ...rest }, timeout())
    personFieldsRefusedAt = null
    return answer
  } catch (err) {
    if (!refusesPersonFields(err)) throw err
    personFieldsRefusedAt = Date.now()
    console.warn(
      'contact service does not take name / company yet (contact-enrichment #19 not deployed): asking without them',
    )
    return await post(path, bare, timeout())
  }
}

/** POST /v1/contacts/lookup through Lyca's order (no `ziplabs: false`). Throws ContactStoreUnavailable. */
export async function serviceLookup(
  person: PersonInput,
  kinds: ContactKind[],
  deadline: Deadline = NO_DEADLINE,
): Promise<ServiceAnswer> {
  const body = await postAboutPerson(
    '/v1/contacts/lookup',
    person,
    { kinds },
    deadline,
  )
  return parseServiceAnswer(body, kinds)
}

/** POST /v1/contacts/find-another for one kind. Throws ContactStoreUnavailable. */
export async function serviceFindAnother(
  person: PersonInput,
  kind: ContactKind,
  shown: string[],
  deadline: Deadline = NO_DEADLINE,
): Promise<ServiceAnswer> {
  const body = await postAboutPerson(
    '/v1/contacts/find-another',
    person,
    { kind, shown },
    deadline,
  )
  return parseServiceAnswer(body, [kind])
}

/**
 * One call, and when it answers a kind as `pending`, one more after
 * `retry_after_ms` (at most 5 s, never past the deadline): the same rule as
 * the store's lookup (flow.ts, askTwiceIfPending). If that second call fails,
 * the first answer stands (its kinds stay pending). The first call's failure
 * is thrown.
 */
export async function askWithPending(
  call: () => Promise<ServiceAnswer>,
  kinds: ContactKind[],
  sleep?: (ms: number) => Promise<void>,
  deadline?: Deadline,
): Promise<ServiceAnswer> {
  const { first, again } = await askTwiceIfPending(
    call,
    (a) => ({
      pending: a.pending.some((k) => kinds.includes(k)),
      retryAfterMs: a.retryAfterMs,
    }),
    { sleep, deadline, label: 'contact service' },
  )
  return again ?? first
}

/** The contact_store row's fields Lyca writes while the setting is on. */
export interface ServiceRowFields {
  status: 'found' | 'not_found' | 'pending' | 'error'
  emails: StoredContact[]
  phones: StoredContact[]
  email_searched: boolean
  phone_searched: boolean
  pending_kinds: ContactKind[] | null
  /** When the pending began (ISO time) while a kind is pending, else null. */
  pending_since: string | null
  error: string | null
  /**
   * Per kind, the source the service's latest answer for that kind named
   * (migration 20261104000002). A kind not asked keeps what it held; an
   * outage changes nothing. Server-side only: never in the panel's payload.
   */
  found_in_by_kind: FoundInByKind | null
}

export const SERVICE_UNREACHABLE = 'The contact service could not be reached.'
export const SOURCE_UNAVAILABLE =
  'A contact source was temporarily unavailable.'

/** A pending kind is re-checked for at most this long after it began; then "temporarily unavailable". */
export const PENDING_RECHECK_MAX_MS = 60_000

/** When the row's pending began (ms), or null. */
export function pendingSince(row: PersonRows['shared']): number | null {
  const raw = row?.pending_since
  if (typeof raw !== 'string' || !raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

const list = <T>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : [])

/** What the row held plus the fresh values (no duplicates); a fresh email check replaces the held one. */
function addValues<T extends { value: string; check?: EmailCheck | null }>(
  kind: ContactKind,
  held: T[],
  fresh: T[],
): T[] {
  const out = held.map((x) => ({ ...x }))
  for (const v of fresh) {
    const same = out.find(
      (x) =>
        typeof x?.value === 'string' && sameContact(kind, x.value, v.value),
    )
    if (!same) out.push(v)
    else if (kind === 'email' && v.check) same.check = v.check
  }
  return out
}

export type ServiceOutcome =
  { answer: ServiceAnswer; findAnother?: boolean } | { outage: true }

/**
 * The person's contact_store row after a call for `kinds`:
 * - an answer adds its values (marked bad left out), keeps what the row held,
 *   records the kinds still pending and, per kind asked for, whether every
 *   source was asked (lookup: `has` false and not pending; find-another:
 *   `exhausted`);
 * - a kind in the answer's `unavailable` is never marked as searched: the row
 *   says a source was unavailable, and the panel says "temporarily
 *   unavailable" for it;
 * - an outage changes no value and nothing final: the row says the call
 *   failed (status 'error' when it holds nothing), so the panel says
 *   "temporarily unavailable" and offers "Try again".
 */
export function nextServiceRow(
  existing: PersonRows['shared'],
  kinds: ContactKind[],
  outcome: ServiceOutcome,
  now: number = Date.now(),
): ServiceRowFields {
  const heldSince = pendingSince(existing)
  const heldEmails = list(existing?.emails) as StoredContact[]
  const heldPhones = list(existing?.phones) as StoredContact[]
  const heldPending = list(existing?.pending_kinds).filter(
    (k) => !kinds.includes(k),
  )
  const searched = {
    email: !!existing?.email_searched,
    phone: !!existing?.phone_searched,
  }
  const heldFoundIn = foundInByKindOf(existing?.found_in_by_kind, KINDS)
  const foundInOrNull = (x: FoundInByKind) => (Object.keys(x).length ? x : null)
  if ('outage' in outcome) {
    const any = heldEmails.length > 0 || heldPhones.length > 0
    return {
      status: any ? 'found' : 'error',
      emails: heldEmails,
      phones: heldPhones,
      email_searched: searched.email,
      phone_searched: searched.phone,
      pending_kinds: heldPending.length ? heldPending : null,
      pending_since:
        heldPending.length && heldSince !== null
          ? new Date(heldSince).toISOString()
          : null,
      error: SERVICE_UNREACHABLE,
      found_in_by_kind: foundInOrNull(heldFoundIn),
    }
  }
  const { answer, findAnother } = outcome
  const emails = addValues<StoredContact & { check?: EmailCheck | null }>(
    'email',
    heldEmails,
    kinds.includes('email') ? answer.emails : [],
  )
  const phones = addValues<StoredContact>(
    'phone',
    heldPhones,
    kinds.includes('phone') ? answer.phones : [],
  )
  const pending = answer.pending.filter((k) => kinds.includes(k))
  // A lookup's `has: false` without found_in_by_kind: the service ran no
  // vendor (Lyca not in its WATERFALLS: the cutover). Unanswered, not "not
  // found" (HIR-537 review).
  const notRun = findAnother
    ? []
    : kinds.filter(
        (k) =>
          !answer.waterfall && answer.has[k] === false && !pending.includes(k),
      )
  const unavailableNow = [
    ...new Set([
      ...(answer.unavailable ?? []).filter(
        (k) => kinds.includes(k) && !pending.includes(k),
      ),
      ...notRun,
    ]),
  ]
  for (const kind of kinds) {
    if (pending.includes(kind) || unavailableNow.includes(kind)) continue
    const nothingLeft = findAnother
      ? answer.exhausted === true
      : answer.has[kind] === false
    if (nothingLeft) searched[kind] = true
  }
  const allPending = [...new Set([...heldPending, ...pending])]
  // A kind not asked now that was unavailable before stays so.
  const holds = (k: ContactKind) =>
    (k === 'email' ? emails : phones).some(
      (v) => typeof v?.value === 'string' && v.value.trim() !== '',
    )
  const stillUnavailable = existing?.error
    ? KINDS.filter(
        (k) =>
          !kinds.includes(k) &&
          !searched[k] &&
          !holds(k) &&
          !heldPending.includes(k),
      )
    : []
  const unavailable = [...unavailableNow, ...stillUnavailable]
  // The pending window: kept while a kind that was pending still is, new otherwise.
  // A window already past its limit is not kept: "Try again" starts a new one.
  const keepsWindow =
    heldSince !== null &&
    now - heldSince <= PENDING_RECHECK_MAX_MS &&
    list(existing?.pending_kinds).some((k) => allPending.includes(k))
  const since = allPending.length
    ? keepsWindow && heldSince !== null
      ? heldSince
      : now
    : null
  return {
    status:
      emails.length || phones.length
        ? 'found'
        : allPending.length
          ? 'pending'
          : unavailable.length
            ? 'error'
            : 'not_found',
    emails,
    phones,
    email_searched: searched.email,
    phone_searched: searched.phone,
    pending_kinds: allPending.length ? allPending : null,
    pending_since: since === null ? null : new Date(since).toISOString(),
    error: unavailable.length ? SOURCE_UNAVAILABLE : null,
    // The kinds asked now take the answer's source; the others keep theirs.
    found_in_by_kind: foundInOrNull({
      ...heldFoundIn,
      ...foundInByKindOf(answer.foundInByKind, kinds),
    }),
  }
}

// ------------------------------------------------------------ the panel

/** What the panel needs per kind (the same shape as with the setting off). */
export interface ServiceKindState {
  searching: boolean
  canFind: boolean
  exhausted: boolean
  unavailable: boolean
}

/** The kind is pending at the service (whatever its age). */
const pendingAt = (rows: PersonRows, kind: ContactKind) =>
  !!rows.shared &&
  rows.shared.status !== 'error' &&
  list(rows.shared.pending_kinds).includes(kind)

/** Pending for longer than PENDING_RECHECK_MAX_MS (or with no start time): no longer re-checked. */
const pendingExpired = (rows: PersonRows, kind: ContactKind, now: number) => {
  if (!pendingAt(rows, kind)) return false
  const since = pendingSince(rows.shared)
  return since === null || now - since > PENDING_RECHECK_MAX_MS
}

/** Pending, and still within its re-check window. */
const pendingFor = (rows: PersonRows, kind: ContactKind, now = Date.now()) =>
  pendingAt(rows, kind) && !pendingExpired(rows, kind, now)

/** Every source of the service's order was asked for this kind. */
export const exhaustedFor = (rows: PersonRows, kind: ContactKind) =>
  !!(kind === 'email'
    ? rows.shared?.email_searched
    : rows.shared?.phone_searched)

/** The last call to the service failed (or the store was never reached). */
const failedLast = (rows: PersonRows) =>
  !!rows.shared && (rows.shared.status === 'error' || !!rows.shared.error)

/** Any source holds a value of this kind its vendor did not call invalid. */
const holdsUsable = (rows: PersonRows, kind: ContactKind) =>
  [rows.shared, rows.salesql, rows.bettercontact].some(
    (row) => usableValuesOf(row, kind).length > 0,
  )

/** Someone was really asked: the service (or the store), or one of Lyca's own vendors before the switch. */
export function serviceLookedUp(rows: PersonRows): boolean {
  const answered = (row: PersonRows['shared']) =>
    !!row && row.status !== 'error'
  return (
    answered(rows.shared) ||
    answered(rows.salesql) ||
    answered(rows.bettercontact)
  )
}

/**
 * An empty kind the service should still be asked for: never answered through
 * the service and not answered by Lyca's own vendors before the switch either
 * (no row, a failed call, or a vendor that never ran for it). A kind every
 * source was asked for, or that is still pending, is not.
 */
function unanswered(
  rows: PersonRows,
  kind: ContactKind,
  now = Date.now(),
): boolean {
  if (holdsUsable(rows, kind) || exhaustedFor(rows, kind)) return false
  if (!rows.shared || failedLast(rows) || pendingExpired(rows, kind, now))
    return true
  const salesqlAsked = !!rows.salesql && rows.salesql.status !== 'error'
  return (
    kindsToResume(rows, [kind], {
      salesqlAsked,
      salesqlReady: true,
      backupReady: true,
    }).length > 0
  )
}

/** "Get contact" on a person looked up before: the kinds to ask the service for again. */
export function kindsToAskAgain(
  rows: PersonRows,
  now = Date.now(),
): ContactKind[] {
  return KINDS.filter(
    (kind) => pendingAt(rows, kind) || unanswered(rows, kind, now),
  )
}

/**
 * The panel's automatic re-check: only the kinds still pending within their
 * window. Never a kind whose vendors were unavailable (HIR-537 review): asking
 * for it can make the service pay a vendor, which only a click (under the
 * lookup limit) may do. That kind shows "Try again".
 */
export function kindsToRecheck(
  rows: PersonRows,
  now = Date.now(),
): ContactKind[] {
  return KINDS.filter((k) => pendingFor(rows, k, now))
}

/** One kind's state for the panel (see the header). */
export function serviceKindState(
  kind: ContactKind,
  items: Array<Pick<ContactItem, 'verdict' | 'invalid'>>,
  rows: PersonRows,
  now = Date.now(),
): ServiceKindState {
  const searching = pendingFor(rows, kind, now)
  const usable = items.filter((x) => x.verdict !== 'bad' && !x.invalid)
  const exhausted = exhaustedFor(rows, kind)
  const unavailable =
    !searching &&
    !exhausted &&
    !usable.length &&
    (kindUnavailable(rows, kind) ||
      failedLast(rows) ||
      pendingExpired(rows, kind, now))
  const thumbsDown = items.some((x) => x.verdict === 'bad')
  return {
    searching,
    canFind:
      serviceLookedUp(rows) &&
      !searching &&
      !exhausted &&
      (thumbsDown ||
        (!usable.length && (unavailable || unanswered(rows, kind, now)))),
    exhausted: exhausted && !usable.length,
    unavailable,
  }
}

/** Every value takes 👍/👎 while on: after any 👎 the service can look further (find-another). */
export function withFeedback<T extends { feedback: boolean }>(items: T[]): T[] {
  return items.map((x) => ({ ...x, feedback: true }))
}

/**
 * What the panel gets for one person while on (index.ts viewsFor adds the
 * name and profile URL). Built field by field: the row's found_in_by_kind,
 * error text and other columns never reach the browser, so it never learns
 * which vendor a value came from.
 */
export function servicePanelView(
  rows: PersonRows,
  emails: ContactItem[],
  phones: ContactItem[],
  unavailableMessage: string,
  now = Date.now(),
) {
  const email = serviceKindState('email', emails, rows, now)
  const phone = serviceKindState('phone', phones, rows, now)
  return {
    lookedUp: serviceLookedUp(rows),
    // An outage is "temporarily unavailable, try again", never "not found".
    error: email.unavailable && phone.unavailable ? unavailableMessage : null,
    // Every value takes 👍/👎: after a 👎 the service can look further.
    emails: withFeedback(emails),
    phones: withFeedback(phones),
    email,
    phone,
  }
}

// ------------------------------------------------------------ the reveal

/** The service could not answer a "Find another": nothing was recorded; the panel says "try again". */
export class ServiceUnavailableError extends Error {}

/** What runViaService needs from index.ts (Supabase there, in memory in the tests). */
export interface ViaServiceDeps {
  /** The person's rows and its 👍/👎, fresh. */
  load(): Promise<{
    rows: PersonRows
    verdicts: Array<{
      contact_kind: string
      contact_value: string
      verdict: 'good' | 'bad'
      reason: string | null
    }>
  }>
  /** Writes the person's contact_store row. */
  saveServiceRow(fields: ServiceRowFields): Promise<void>
  /** Throws when the caller is over the lookup limit. */
  enforceLimit(): Promise<void>
  /** How to wait for `retry_after_ms` (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
  /** The clock (tests pass a fake). */
  now?: () => number
  /** The request's deadline (deadline.ts); none in tests that leave it out. */
  deadline?: Deadline
}

const clock = (deps: ViaServiceDeps) => (deps.now ? deps.now() : Date.now())

/** The values of one kind as the panel lists them, with the workspace's verdicts. */
export function itemsOf(
  kind: ContactKind,
  rows: PersonRows,
  verdicts: Awaited<ReturnType<ViaServiceDeps['load']>>['verdicts'],
): ContactItem[] {
  return mergeContacts(kind, rows, (value) => {
    const f = verdicts.find(
      (v) =>
        v.contact_kind === kind && sameContact(kind, v.contact_value, value),
    )
    return f ? { verdict: f.verdict, reason: f.reason } : null
  })
}

/** Every value of a kind Lyca already shows for this person (find-another's `shown`). */
function shownValues(rows: PersonRows, kind: ContactKind): string[] {
  const out: string[] = []
  for (const row of [rows.shared, rows.salesql, rows.bettercontact]) {
    for (const v of list(kind === 'email' ? row?.emails : row?.phones)) {
      if (
        typeof v?.value === 'string' &&
        v.value.trim() !== '' &&
        !out.some((x) => sameContact(kind, x, v.value))
      ) {
        out.push(v.value)
      }
    }
  }
  return out
}

/**
 * A lookup through the service for `kinds`, written to the row. An outage is
 * recorded as such (never "not found") and not thrown: the panel shows it.
 */
async function lookupAndSave(
  deps: ViaServiceDeps,
  person: PersonInput,
  kinds: ContactKind[],
): Promise<void> {
  const deadline = deps.deadline ?? NO_DEADLINE
  let outcome: ServiceOutcome
  try {
    const answer = await askWithPending(
      () => serviceLookup(person, kinds, deadline),
      kinds,
      deps.sleep,
      deadline,
    )
    if (!answer.waterfall && kinds.some((k) => answer.has[k] === false)) {
      console.warn(
        `${VIA_SERVICE_SETTING} is on but the contact service did not run Lyca's order (no found_in_by_kind: lyca is not in its WATERFALLS); kinds it had nothing for are left unanswered`,
      )
    }
    outcome = { answer }
  } catch (err) {
    logStoreFailure('contact service lookup failed', err)
    outcome = { outage: true }
  }
  const { rows } = await deps.load()
  await deps.saveServiceRow(
    nextServiceRow(rows.shared, kinds, outcome, clock(deps)),
  )
}

/**
 * The reveal with CONTACT_VENDORS_VIA_SERVICE on. Lyca calls no vendor:
 * - 'lookup' ("Get contact"): one lookup for both kinds; a person looked up
 *   before only for the kinds still unanswered or pending;
 * - 'backup' ("Find another" / "Find email / number" / "Try again"), only for
 *   kinds the panel offers it for: find-another after a 👎, else a lookup;
 * - 'refresh': the kinds the service was still fetching, asked again.
 */
export async function runViaService(
  deps: ViaServiceDeps,
  person: PersonInput,
  mode: 'lookup' | 'backup' | 'refresh',
  kinds: ContactKind[],
): Promise<void> {
  if (!contactStoreConfigured()) {
    console.error(
      `${VIA_SERVICE_SETTING} is on but CONTACT_ENRICHMENT_URL / CONTACT_ENRICHMENT_API_KEY are not set`,
    )
    throw new ServiceUnavailableError('The contact service is not configured.')
  }
  const { rows, verdicts } = await deps.load()

  if (mode === 'refresh') {
    // The panel's automatic re-check: pending kinds only, within their window.
    const recheck = kindsToRecheck(rows, clock(deps))
    if (recheck.length) await lookupAndSave(deps, person, recheck)
    return
  }

  if (mode === 'lookup') {
    const ask = serviceLookedUp(rows)
      ? kindsToAskAgain(rows, clock(deps))
      : KINDS
    if (!ask.length) return
    await deps.enforceLimit()
    await lookupAndSave(deps, person, ask)
    return
  }

  // 'backup': only where the panel offers it.
  const allowed = kinds.filter(
    (k) =>
      serviceKindState(k, itemsOf(k, rows, verdicts), rows, clock(deps))
        .canFind,
  )
  if (!allowed.length) return
  await deps.enforceLimit()
  const thumbsDown = (k: ContactKind) =>
    itemsOf(k, rows, verdicts).some((x) => x.verdict === 'bad')
  const toLookUp = allowed.filter((k) => !thumbsDown(k))
  if (toLookUp.length) await lookupAndSave(deps, person, toLookUp)
  const deadline = deps.deadline ?? NO_DEADLINE
  let asked = 0
  for (const kind of allowed.filter(thumbsDown)) {
    // A second kind only with time for a whole call; otherwise the panel
    // keeps offering it (one request never runs about 90 s: HIR-537 review).
    if (asked++ > 0 && !deadline.allows(VIA_SERVICE_MIN_TIMEOUT_MS)) break
    let answer: ServiceAnswer
    try {
      answer = await askWithPending(
        () =>
          serviceFindAnother(person, kind, shownValues(rows, kind), deadline),
        [kind],
        deps.sleep,
        deadline,
      )
    } catch (err) {
      // 409 find_another_not_available: Lyca is not in the service's
      // WATERFALLS, a setup fault; logged like any refused call.
      logStoreFailure('contact service find-another failed', err)
      throw new ServiceUnavailableError(
        err instanceof ContactStoreUnavailable ? err.message : String(err),
      )
    }
    const fresh = (await deps.load()).rows
    await deps.saveServiceRow(
      nextServiceRow(
        fresh.shared,
        [kind],
        { answer, findAnother: true },
        clock(deps),
      ),
    )
  }
}
