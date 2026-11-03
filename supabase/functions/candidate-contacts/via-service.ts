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
//                     was asked: "No other email / number found".
//   👍/👎            -> unchanged: saved in Lyca's table and sent to the store
//                     (POST /v1/contacts/feedback, contact-store.ts).
//   An outage      -> any failure (503 vendors_unavailable / store_unavailable,
//                     a timeout, a refused key) is "temporarily unavailable,
//                     try again" and nothing final is recorded: never "not
//                     found".
// The wait is CONTACT_ENRICHMENT_TIMEOUT_MS, at least 20 s while on (each
// vendor slot of the service's order can take its own timeout).
//
// What is kept: the answer is Lyca's `contact_store` row in
// candidate_contact_lookups, as before. Its values are what the service
// returned that is not marked bad. Each email also keeps the service's email
// check result (`check`: valid / invalid / unknown); Lyca runs no check of its
// own and hides nothing because of it. Two of the row's columns get a meaning
// for this row while on: email_searched / phone_searched = every source was
// asked for that kind (nothing more to find), and pending_kinds = the kinds
// the service was still fetching.
//
// Kept free of Supabase so it can be tested on its own (via-service_test.ts):
// index.ts gives it the person's rows and a way to write the row.

import {
  ContactStoreUnavailable,
  contactStoreConfigured,
  logStoreFailure,
  post,
} from './contact-store.ts'
import {
  kindsToResume,
  kindUnavailable,
  mergeContacts,
  PENDING_WAIT_MAX_MS,
  sameContact,
  usableValuesOf,
  type ContactItem,
  type PersonRows,
  type StoredContact,
} from './flow.ts'
import type { ContactKind } from './vendors.ts'

/** The function secret that sends every vendor call through the service. */
export const VIA_SERVICE_SETTING = 'CONTACT_VENDORS_VIA_SERVICE'

/** True only for CONTACT_VENDORS_VIA_SERVICE=true; unset or anything else is off. */
export function contactVendorsViaService(): boolean {
  return Deno.env.get(VIA_SERVICE_SETTING)?.trim().toLowerCase() === 'true'
}

/** The least a reveal waits for the service while on: its order takes a vendor timeout per slot. */
export const VIA_SERVICE_MIN_TIMEOUT_MS = 20_000

/** CONTACT_ENRICHMENT_TIMEOUT_MS, raised to at least 20 s (unset: 20 s). */
export function viaServiceTimeoutMs(): number {
  const raw = Number(Deno.env.get('CONTACT_ENRICHMENT_TIMEOUT_MS')?.trim())
  const set = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  return Math.max(set, VIA_SERVICE_MIN_TIMEOUT_MS)
}

const KINDS: ContactKind[] = ['email', 'phone']
const PENDING_WAIT_DEFAULT_MS = 1_000

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
}

interface WireContact {
  value?: unknown
  status?: unknown
  verified?: unknown
  check?: { result?: unknown } | null
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
  const usable = (items: unknown) =>
    (Array.isArray(items) ? (items as WireContact[]) : []).filter(
      (c): c is WireContact & { value: string } =>
        !!c &&
        typeof c.value === 'string' &&
        c.value.trim() !== '' &&
        c.status !== 'bad',
    )
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
  const pending = (Array.isArray(b.pending) ? b.pending : []).filter(
    (k): k is ContactKind =>
      (k === 'email' || k === 'phone') && kinds.includes(k),
  )
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

/** linkedin_url, plus `name` / `company` when not empty. */
export function personFields(person: PersonInput): {
  linkedin_url: string
  name?: string
  company?: string
} {
  const p = typeof person === 'string' ? { linkedinUrl: person } : person
  const name = cleanName(p.name)
  const company = (p.company ?? '').trim()
  return {
    linkedin_url: p.linkedinUrl,
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
  }
}

/** POST /v1/contacts/lookup through Lyca's order (no `ziplabs: false`). Throws ContactStoreUnavailable. */
export async function serviceLookup(
  person: PersonInput,
  kinds: ContactKind[],
): Promise<ServiceAnswer> {
  const body = await post(
    '/v1/contacts/lookup',
    { ...personFields(person), kinds },
    viaServiceTimeoutMs(),
  )
  return parseServiceAnswer(body, kinds)
}

/** POST /v1/contacts/find-another for one kind. Throws ContactStoreUnavailable. */
export async function serviceFindAnother(
  person: PersonInput,
  kind: ContactKind,
  shown: string[],
): Promise<ServiceAnswer> {
  const body = await post(
    '/v1/contacts/find-another',
    { ...personFields(person), kind, shown },
    viaServiceTimeoutMs(),
  )
  return parseServiceAnswer(body, [kind])
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * One call, and when it answers a kind as `pending`, one more after
 * `retry_after_ms` (at most 5 s). If that second call fails, the first answer
 * stands (its kinds stay pending). The first call's failure is thrown.
 */
export async function askWithPending(
  call: () => Promise<ServiceAnswer>,
  kinds: ContactKind[],
  sleep: (ms: number) => Promise<void> = wait,
): Promise<ServiceAnswer> {
  const first = await call()
  if (!first.pending.some((k) => kinds.includes(k))) return first
  const after = Number(first.retryAfterMs)
  const ms =
    Number.isFinite(after) && after >= 0 ? after : PENDING_WAIT_DEFAULT_MS
  await sleep(Math.min(ms, PENDING_WAIT_MAX_MS))
  try {
    return await call()
  } catch (err) {
    logStoreFailure(
      'contact service re-ask failed, using the first answer',
      err,
    )
    return first
  }
}

/** The contact_store row's fields Lyca writes while the setting is on. */
export interface ServiceRowFields {
  status: 'found' | 'not_found' | 'pending' | 'error'
  emails: StoredContact[]
  phones: StoredContact[]
  email_searched: boolean
  phone_searched: boolean
  pending_kinds: ContactKind[] | null
  error: string | null
}

export const SERVICE_UNREACHABLE = 'The contact service could not be reached.'

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
 * - an outage changes no value and nothing final: the row says the call
 *   failed (status 'error' when it holds nothing), so the panel says
 *   "temporarily unavailable" and offers "Try again".
 */
export function nextServiceRow(
  existing: PersonRows['shared'],
  kinds: ContactKind[],
  outcome: ServiceOutcome,
): ServiceRowFields {
  const heldEmails = list(existing?.emails) as StoredContact[]
  const heldPhones = list(existing?.phones) as StoredContact[]
  const heldPending = list(existing?.pending_kinds).filter(
    (k) => !kinds.includes(k),
  )
  const searched = {
    email: !!existing?.email_searched,
    phone: !!existing?.phone_searched,
  }
  if ('outage' in outcome) {
    const any = heldEmails.length > 0 || heldPhones.length > 0
    return {
      status: any ? 'found' : 'error',
      emails: heldEmails,
      phones: heldPhones,
      email_searched: searched.email,
      phone_searched: searched.phone,
      pending_kinds: heldPending.length ? heldPending : null,
      error: SERVICE_UNREACHABLE,
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
  for (const kind of kinds) {
    if (pending.includes(kind)) continue
    const nothingLeft = findAnother
      ? answer.exhausted === true
      : answer.has[kind] === false
    if (nothingLeft) searched[kind] = true
  }
  const allPending = [...new Set([...heldPending, ...pending])]
  return {
    status:
      emails.length || phones.length
        ? 'found'
        : allPending.length
          ? 'pending'
          : 'not_found',
    emails,
    phones,
    email_searched: searched.email,
    phone_searched: searched.phone,
    pending_kinds: allPending.length ? allPending : null,
    error: null,
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

const pendingFor = (rows: PersonRows, kind: ContactKind) =>
  !!rows.shared &&
  rows.shared.status !== 'error' &&
  list(rows.shared.pending_kinds).includes(kind)

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
function unanswered(rows: PersonRows, kind: ContactKind): boolean {
  if (holdsUsable(rows, kind) || exhaustedFor(rows, kind)) return false
  if (!rows.shared || failedLast(rows)) return true
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
export function kindsToAskAgain(rows: PersonRows): ContactKind[] {
  return KINDS.filter(
    (kind) => pendingFor(rows, kind) || unanswered(rows, kind),
  )
}

/** One kind's state for the panel (see the header). */
export function serviceKindState(
  kind: ContactKind,
  items: Array<Pick<ContactItem, 'verdict' | 'invalid'>>,
  rows: PersonRows,
): ServiceKindState {
  const searching = pendingFor(rows, kind)
  const usable = items.filter((x) => x.verdict !== 'bad' && !x.invalid)
  const exhausted = exhaustedFor(rows, kind)
  const unavailable =
    !searching &&
    !exhausted &&
    !usable.length &&
    (kindUnavailable(rows, kind) || failedLast(rows))
  const thumbsDown = items.some((x) => x.verdict === 'bad')
  return {
    searching,
    canFind:
      serviceLookedUp(rows) &&
      !searching &&
      !exhausted &&
      (thumbsDown ||
        (!usable.length && (unavailable || unanswered(rows, kind)))),
    exhausted: exhausted && !usable.length,
    unavailable,
  }
}

/** Every value takes 👍/👎 while on: after any 👎 the service can look further (find-another). */
export function withFeedback<T extends { feedback: boolean }>(items: T[]): T[] {
  return items.map((x) => ({ ...x, feedback: true }))
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
}

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
  let outcome: ServiceOutcome
  try {
    outcome = {
      answer: await askWithPending(
        () => serviceLookup(person, kinds),
        kinds,
        deps.sleep,
      ),
    }
  } catch (err) {
    logStoreFailure('contact service lookup failed', err)
    outcome = { outage: true }
  }
  const { rows } = await deps.load()
  await deps.saveServiceRow(nextServiceRow(rows.shared, kinds, outcome))
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
    const pending = KINDS.filter((k) => pendingFor(rows, k))
    if (pending.length) await lookupAndSave(deps, person, pending)
    return
  }

  if (mode === 'lookup') {
    const ask = serviceLookedUp(rows) ? kindsToAskAgain(rows) : KINDS
    if (!ask.length) return
    await deps.enforceLimit()
    await lookupAndSave(deps, person, ask)
    return
  }

  // 'backup': only where the panel offers it.
  const allowed = kinds.filter(
    (k) => serviceKindState(k, itemsOf(k, rows, verdicts), rows).canFind,
  )
  if (!allowed.length) return
  await deps.enforceLimit()
  const thumbsDown = (k: ContactKind) =>
    itemsOf(k, rows, verdicts).some((x) => x.verdict === 'bad')
  const toLookUp = allowed.filter((k) => !thumbsDown(k))
  if (toLookUp.length) await lookupAndSave(deps, person, toLookUp)
  for (const kind of allowed.filter(thumbsDown)) {
    let answer: ServiceAnswer
    try {
      answer = await askWithPending(
        () => serviceFindAnother(person, kind, shownValues(rows, kind)),
        [kind],
        deps.sleep,
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
      nextServiceRow(fresh.shared, [kind], { answer, findAnother: true }),
    )
  }
}
