// Candidate contacts — email + phone for a dashboard's candidates, from
// external vendors: SalesQL first, BetterContact as the backup. Vendor names
// stay server-side: the dashboard only ever sees "Email" and "Phone".
//
// Actions (POST { action, payload }):
//   list      { dashboardId }                       -> every looked-up contact on that dashboard
//   lookup    { dashboardId, candidateName, linkedinUrl?, mode: 'lookup'|'backup'|'refresh', kinds? }
//   feedback  { dashboardId, candidateName, linkedinUrl?, kind, value, verdict, reason? }
//
// Who:
//   list / feedback — anyone who can see the dashboard (dashboards RLS,
//                     checked with the CALLER's own client).
//   lookup          — Admin and Super Admin only: it spends vendor credits.
//
// Credits are protected three ways: a lookup is only made for a LinkedIn
// profile that appears in the dashboard's own stored HTML (never a free-form
// URL from the request); every vendor answer is cached per profile+vendor
// (candidate_contact_lookups) and reused, including across dashboards; and
// each caller is limited to LOOKUP_LIMIT vendor calls per window.
//
// The flow (HIR-491, decisions in flow.ts):
//   "Get contact" ('lookup')  -> the shared contact store first (contact-store.ts:
//                                what any HireSense platform revealed, then
//                                ZipLabs). For each kind it has nothing for,
//                                Lyca's vendors run straight away, no click:
//                                SalesQL, then BetterContact for what SalesQL
//                                did not find. Store unconfigured or
//                                unreachable (or slower than
//                                CONTACT_ENRICHMENT_TIMEOUT_MS): the vendors,
//                                as before. Every vendor answer and every 👍/👎
//                                is written back in the background.
//                                A person looked up before is only resumed:
//                                kinds with no value that a vendor never
//                                answered for (older rows, vendor errors).
//   Each value shown carries `source` ('store' | 'vendor', never which
//   vendor) and `feedback`: 👍/👎 on store values and on SalesQL values while
//   BetterContact has not been asked for that kind; never on BetterContact
//   values — see flow.ts.
//   'backup' + kinds          -> "Find another email / number": after a 👎 on
//                                a store value, the next vendor not yet asked
//                                for that kind (SalesQL, else BetterContact);
//                                after a 👎 on a SalesQL value, BetterContact.
//                                Never after BetterContact. Also "Find email /
//                                number" for an empty kind a vendor never
//                                answered for. Each kind is bought from each
//                                vendor at most once per person.
//   'refresh'                 -> re-check a backup search still running
//                                (a status check — never charges).

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  extractCandidates,
  linkedinKey,
  type DashboardCandidate,
} from './candidates.ts'
import {
  betterContactLookup,
  betterContactPoll,
  salesqlLookup,
  vendorConfigured,
  type ContactKind,
  type Source,
  type VendorResult,
} from './vendors.ts'
import {
  contactStoreConfigured,
  contactStoreFeedbackLater,
  contactStoreLookup,
  contactStoreSaveLater,
} from './contact-store.ts'
import {
  canFindAnother,
  contactId,
  isInvalid,
  kindsForStore,
  kindsMissing,
  kindsToResume,
  kindUnavailable,
  sameContact,
  usableValuesOf,
  mergeContacts,
  storeFirst,
  takesFeedback,
  valuesByOrigin,
  type PersonRows,
} from './flow.ts'
import { upsertUnsynced, type RowVersion } from './store-sync.ts'
import { onceAtATime } from './claims.ts'
import { supabaseClaims } from './claims-db.ts'
import { markSynced } from './store-sync-db.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://adobe-longlist.vercel.app',
  'https://longlist.hiresense.ai',
])

const MAX_BODY_BYTES = 4_000
const UNAVAILABLE =
  'Contact lookup is temporarily unavailable — try again shortly.'
const LOOKUP_LIMIT = 60
const LOOKUP_WINDOW_MINUTES = 10
const REASONS = new Set([
  'bounced',
  'wrong_person',
  'not_reachable',
  'no_answer',
])

type CallerRole = 'super_admin' | 'admin' | 'viewer'
type Admin = ReturnType<typeof createClient>

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed =
    ALLOWED_ORIGINS.has(origin) ||
    (origin.endsWith('.vercel.app') && origin.includes('adobe-longlist'))
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(
  body: unknown,
  status = 200,
  cors: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LookupRow {
  linkedin_key: string
  linkedin_url: string
  vendor: Source
  status: VendorResult['status']
  emails: Array<{ value: string; type: string | null; status: string | null }>
  phones: Array<{ value: string; type: string | null; valid: boolean | null }>
  vendor_request_id: string | null
  error: string | null
  email_searched: boolean
  phone_searched: boolean
  pending_kinds: ContactKind[] | null
  updated_at: string
}

interface FeedbackRow {
  linkedin_key: string
  contact_kind: 'email' | 'phone'
  contact_value: string
  verdict: 'good' | 'bad'
  reason: string | null
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405, cors)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader)
    return json({ error: 'Missing Authorization header' }, 401, cors)

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser()
  if (callerError || !caller)
    return json({ error: 'Invalid session' }, 401, cors)

  const { data: profile } = await callerClient
    .from('profiles')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle()
  const role = profile?.role as CallerRole | undefined
  if (!role) return json({ error: 'Forbidden' }, 403, cors)

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES)
    return json({ error: 'Request body too large' }, 413, cors)
  let body: { action?: string; payload?: Record<string, unknown> }
  try {
    body = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors)
  }
  const payload = body.payload ?? {}
  const dashboardId =
    typeof payload.dashboardId === 'string' ? payload.dashboardId : ''
  if (!dashboardId) return json({ error: 'dashboardId is required' }, 400, cors)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  try {
    // Visibility with the caller's OWN client: dashboards RLS decides.
    const { data: dashboard } = await callerClient
      .from('dashboards')
      .select('id, storage_path')
      .eq('id', dashboardId)
      .maybeSingle()
    if (!dashboard) throw new HttpError(404, 'Dashboard not found.')

    const candidates = await loadCandidates(admin, dashboard.storage_path)

    switch (body.action) {
      case 'list':
        return json({ contacts: await viewsFor(admin, candidates) }, 200, cors)
      case 'lookup': {
        if (role !== 'admin' && role !== 'super_admin') {
          throw new HttpError(403, 'Only Admins can look up contact details.')
        }
        const candidate = findCandidate(candidates, payload)
        const mode =
          payload.mode === 'backup' || payload.mode === 'refresh'
            ? payload.mode
            : 'lookup'
        const kinds = (Array.isArray(payload.kinds) ? payload.kinds : [])
          .filter((k): k is ContactKind => k === 'email' || k === 'phone')
          .filter((k, i, all) => all.indexOf(k) === i)
        if (mode === 'backup' && !kinds.length) {
          throw new HttpError(400, 'Say what to search for: email or phone.')
        }
        await runLookup(admin, candidate, mode, kinds, caller.id, dashboardId)
        return json(
          { contact: (await viewsFor(admin, [candidate]))[0] },
          200,
          cors,
        )
      }
      case 'feedback': {
        const candidate = findCandidate(candidates, payload)
        // Only records the verdict. A 👎 on a store or SalesQL contact makes
        // the panel offer "Find another email / number" — it never calls a vendor.
        await saveFeedback(admin, candidate, payload, caller.id, dashboardId)
        return json(
          { contact: (await viewsFor(admin, [candidate]))[0] },
          200,
          cors,
        )
      }
      default:
        throw new HttpError(400, 'Unknown action')
    }
  } catch (err) {
    if (err instanceof HttpError)
      return json({ error: err.message }, err.status, cors)
    console.error('candidate-contacts error:', err)
    return json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      500,
      cors,
    )
  }
})

async function loadCandidates(
  admin: Admin,
  storagePath: string,
): Promise<DashboardCandidate[]> {
  const { data, error } = await admin.storage
    .from('dashboards')
    .download(storagePath)
  if (error || !data)
    throw new HttpError(500, 'Could not read the dashboard file.')
  return extractCandidates(await data.text())
}

function findCandidate(
  candidates: DashboardCandidate[],
  payload: Record<string, unknown>,
): DashboardCandidate {
  const url = typeof payload.linkedinUrl === 'string' ? payload.linkedinUrl : ''
  const key = url ? linkedinKey(url) : null
  const name =
    typeof payload.candidateName === 'string'
      ? payload.candidateName.trim().toLowerCase()
      : ''
  const byKey = key ? candidates.find((c) => c.linkedinKey === key) : undefined
  const match = byKey ?? candidates.find((c) => c.name.toLowerCase() === name)
  if (!match)
    throw new HttpError(
      404,
      'This candidate has no LinkedIn profile on this dashboard.',
    )
  return match
}

async function rowsFor(
  admin: Admin,
  keys: string[],
): Promise<{ lookups: LookupRow[]; feedback: FeedbackRow[] }> {
  if (!keys.length) return { lookups: [], feedback: [] }
  const [lookups, feedback] = await Promise.all([
    admin
      .from('candidate_contact_lookups')
      .select(
        'linkedin_key, linkedin_url, vendor, status, emails, phones, vendor_request_id, error, email_searched, phone_searched, pending_kinds, updated_at',
      )
      .in('linkedin_key', keys),
    admin
      .from('candidate_contact_feedback')
      .select('linkedin_key, contact_kind, contact_value, verdict, reason')
      .in('linkedin_key', keys),
  ])
  if (lookups.error) throw lookups.error
  if (feedback.error) throw feedback.error
  return { lookups: lookups.data ?? [], feedback: feedback.data ?? [] }
}

/** What the dashboard shows per candidate (only candidates with a lookup). */
async function viewsFor(admin: Admin, candidates: DashboardCandidate[]) {
  const { lookups, feedback } = await rowsFor(
    admin,
    candidates.map((c) => c.linkedinKey),
  )
  // Compared in the shared format (a verdict on "+91 98765 43210" holds for
  // "9876543210" too).
  const verdictOf = (k: string, kind: ContactKind, value: string) =>
    feedback.find(
      (f) =>
        f.linkedin_key === k &&
        f.contact_kind === kind &&
        sameContact(kind, f.contact_value, value),
    ) ?? null
  const storeReady = contactStoreConfigured()

  const backupReady = vendorConfigured('bettercontact')
  const salesqlReady = vendorConfigured('salesql')
  const out = []
  for (const c of candidates) {
    const mine = lookups.filter((l) => l.linkedin_key === c.linkedinKey)
    if (!mine.length) continue
    const sales = mine.find((l) => l.vendor === 'salesql')
    const backup = mine.find((l) => l.vendor === 'bettercontact')
    // An answer from the shared contact store counts as the lookup, like SalesQL's.
    const shared = mine.find((l) => l.vendor === 'contact_store')
    const lookedUp =
      (!!sales && sales.status !== 'error') ||
      shared?.status === 'found' ||
      (!!backup && backup.status !== 'error')

    // One list per kind, store values first, duplicates dropped. Each value
    // says only whether it is a store value or one of Lyca's vendors', and
    // whether it takes 👍/👎 — decided from these rows, never which vendor
    // (flow.ts).
    const rows: PersonRows = {
      shared,
      salesql: sales,
      bettercontact: backup,
    }
    const merge = (kind: ContactKind) =>
      mergeContacts(kind, rows, (value) =>
        verdictOf(c.linkedinKey, kind, value),
      )
    const emails = merge('email')
    const phones = merge('phone')

    const kindState = (kind: ContactKind, items: typeof emails) => {
      const searched =
        kind === 'email' ? backup?.email_searched : backup?.phone_searched
      const searching =
        backup?.status === 'pending' && !!backup.pending_kinds?.includes(kind)
      const usable = items.filter((x) => x.verdict !== 'bad' && !x.invalid)
      const { storeValues, salesqlValues } = valuesByOrigin(kind, items, rows)
      const salesqlAsked = !!sales && sales.status !== 'error'
      return {
        searching,
        // Nothing usable while a source failed (the store down, a vendor
        // error): "temporarily unavailable, try again", not "No email found".
        unavailable: !searching && kindUnavailable(rows, kind),
        // "Find another" after a 👎 on a store value (next vendor not yet
        // asked) or on a SalesQL value (BetterContact) — flow.ts. Also "Find
        // email / number" for an empty kind no vendor answered for yet (an
        // older lookup, or a vendor error), so it is never stuck.
        canFind:
          lookedUp &&
          !searching &&
          (canFindAnother({
            kind,
            items,
            storeValues,
            salesqlValues,
            salesqlAsked,
            backupAsked: !!searched,
            salesqlReady,
            backupReady,
          }) ||
            kindsToResume(rows, [kind], {
              salesqlAsked,
              salesqlReady,
              backupReady,
            }).length > 0 ||
            // The store was never really asked for this person (down at the
            // time, or a lookup from before it): asking it is the next step.
            kindsForStore(rows, [kind], storeReady).length > 0),
        exhausted: !!searched && !usable.length,
      }
    }

    out.push({
      candidateName: c.name,
      linkedinUrl: c.linkedinUrl,
      lookedUp,
      // A source failed and nothing usable came back at all: "temporarily
      // unavailable, try again" (HIR-528), never a final "not found". The
      // vendor's own message stays in its row for us.
      error:
        kindUnavailable(rows, 'email') && kindUnavailable(rows, 'phone')
          ? UNAVAILABLE
          : sales?.status === 'error'
            ? sales.error
            : backup?.error && backup.status !== 'pending'
              ? backup.error
              : null,
      emails,
      phones,
      email: kindState('email', emails),
      phone: kindState('phone', phones),
    })
  }
  return out
}

async function enforceLimit(admin: Admin, callerId: string) {
  const since = new Date(
    Date.now() - LOOKUP_WINDOW_MINUTES * 60_000,
  ).toISOString()
  const { count, error } = await admin
    .from('candidate_contact_lookups')
    .select('id', { count: 'exact', head: true })
    .eq('requested_by', callerId)
    .gte('updated_at', since)
  if (error) throw error
  if ((count ?? 0) >= LOOKUP_LIMIT) {
    throw new HttpError(
      429,
      `Lookup limit reached (${LOOKUP_LIMIT} per ${LOOKUP_WINDOW_MINUTES} minutes). Try again shortly.`,
    )
  }
}

/**
 * Saves a lookup row; it counts as not yet in the shared store until a send of
 * exactly this version lands (store-sync.ts). Returns that version.
 */
async function store(
  admin: Admin,
  candidate: DashboardCandidate,
  vendor: Source,
  result: VendorResult,
  callerId: string,
  dashboardId: string,
): Promise<RowVersion> {
  return await upsertUnsynced(
    admin,
    'candidate_contact_lookups',
    {
      linkedin_key: candidate.linkedinKey,
      linkedin_url: candidate.linkedinUrl,
      vendor,
      status: result.status,
      emails: result.emails,
      phones: result.phones,
      vendor_request_id: result.requestId ?? null,
      error: result.error ?? null,
      credits_used: result.creditsUsed ?? null,
      dashboard_id: dashboardId,
      candidate_name: candidate.name,
      requested_by: callerId,
    },
    'linkedin_key,vendor',
  )
}

/** Marks a lookup row synced once its send landed (only that same version). */
const markLookupSynced = (admin: Admin, saved: RowVersion) => () =>
  markSynced(admin, 'candidate_contact_lookups', saved.id, saved.updated_at)

async function runLookup(
  admin: Admin,
  candidate: DashboardCandidate,
  mode: 'lookup' | 'backup' | 'refresh',
  kinds: ContactKind[],
  callerId: string,
  dashboardId: string,
) {
  const { lookups } = await rowsFor(admin, [candidate.linkedinKey])
  const sales = lookups.find((l) => l.vendor === 'salesql')
  const backup = lookups.find((l) => l.vendor === 'bettercontact') ?? null

  // A backup request already in flight is only ever polled (free) — a new
  // POST would charge again. Covers 'refresh' and a repeated 'backup' click.
  if (backup?.status === 'pending' && backup.vendor_request_id) {
    if (mode === 'lookup') return
    const polled = await betterContactPoll(backup.vendor_request_id)
    // (A request from before per-kind searches asked for both.)
    const pendingKinds: ContactKind[] = backup.pending_kinds ?? [
      'email',
      'phone',
    ]
    await storeBackup(
      admin,
      candidate,
      backup,
      pendingKinds,
      polled,
      callerId,
      dashboardId,
    )
    return
  }
  if (mode === 'refresh') return

  if (mode === 'backup') {
    // "Find another": only when the panel offers it — after a 👎 on a store
    // or SalesQL value of that kind with a vendor left to ask, or for an
    // empty kind no vendor answered for yet (flow.ts).
    const view = (await viewsFor(admin, [candidate]))[0]
    const allowed = kinds.filter(
      (k) => (k === 'email' ? view?.email : view?.phone)?.canFind,
    )
    if (!allowed.length) return
    // The store first (HIR-528): a value it has that is new here (not shown,
    // not marked 👎) answers that kind without a paid vendor.
    const fromStore = await askStore(
      admin,
      candidate,
      allowed,
      lookups,
      callerId,
      dashboardId,
    )
    const left = allowed.filter((k) => !fromStore.newKinds.includes(k))
    if (!left.length) return
    await runVendors(
      admin,
      candidate,
      left,
      sales ?? null,
      backup,
      callerId,
      dashboardId,
      true,
    )
    return
  }

  // "Get contact": once per person — any earlier answer stands. A person
  // looked up before is only resumed: kinds with no usable value that the
  // store was never really asked for (it was down, or the lookup predates it)
  // go to the store first; then kinds a configured vendor never answered for
  // (a lookup from before BetterContact ran on its own, or a vendor error).
  // Nothing already answered is re-bought.
  const shared = lookups.find((l) => l.vendor === 'contact_store')
  const salesqlAsked = !!sales && sales.status !== 'error'
  if (
    salesqlAsked ||
    shared?.status === 'found' ||
    (backup && backup.status !== 'error')
  ) {
    const rows = { shared, salesql: sales, bettercontact: backup }
    const forStore = kindsForStore(
      rows,
      ['email', 'phone'],
      contactStoreConfigured(),
    )
    let current = lookups
    if (forStore.length) {
      await enforceLimit(admin, callerId)
      await askStore(admin, candidate, forStore, lookups, callerId, dashboardId)
      current = (await rowsFor(admin, [candidate.linkedinKey])).lookups
    }
    const now = {
      shared: current.find((l) => l.vendor === 'contact_store'),
      salesql: current.find((l) => l.vendor === 'salesql'),
      bettercontact: current.find((l) => l.vendor === 'bettercontact'),
    }
    const resume = kindsToResume(now, ['email', 'phone'], {
      salesqlAsked,
      salesqlReady: vendorConfigured('salesql'),
      backupReady: vendorConfigured('bettercontact'),
    })
    if (resume.length) {
      await runVendors(
        admin,
        candidate,
        resume,
        now.salesql ?? null,
        now.bettercontact ?? null,
        callerId,
        dashboardId,
      )
    }
    return
  }

  // The shared contact store first: contacts any HireSense platform already
  // revealed, then ZipLabs. If it can't be reached in time (or answers with
  // an error), the vendors run as before; that is recorded (a contact_store
  // row with status 'error'), so a later "Get contact" asks the store again
  // and the panel says "temporarily unavailable", not a final "not found".
  let missing: ContactKind[] = ['email', 'phone']
  if (contactStoreConfigured()) {
    await enforceLimit(admin, callerId)
    missing = (
      await askStore(admin, candidate, missing, lookups, callerId, dashboardId)
    ).missing
  }
  // For every kind the store had nothing for, the vendors run now — no click.
  if (missing.length) {
    await runVendors(
      admin,
      candidate,
      missing,
      sales ?? null,
      backup,
      callerId,
      dashboardId,
    )
  }
}

/**
 * Asks the shared store for `kinds` and records its answer as the person's
 * contact_store row: its values added to what the row held (found), nothing
 * (not_found), or, when the store could not answer and the row holds nothing,
 * status 'error' (the store was not really asked). Returns the kinds still
 * missing, and the kinds it brought a value for that is new here: not shown
 * by any row yet and not marked 👎.
 */
async function askStore(
  admin: Admin,
  candidate: DashboardCandidate,
  kinds: ContactKind[],
  lookups: LookupRow[],
  callerId: string,
  dashboardId: string,
): Promise<{ missing: ContactKind[]; newKinds: ContactKind[] }> {
  if (!contactStoreConfigured()) return { missing: kinds, newKinds: [] }
  const existing = lookups.find((l) => l.vendor === 'contact_store') ?? null
  let unavailable = false
  const answer = await storeFirst(
    () => contactStoreLookup(candidate.linkedinUrl, kinds),
    kinds,
    { onUnavailable: () => (unavailable = true) },
  )
  const { feedback } = await rowsFor(admin, [candidate.linkedinKey])
  const shownBefore = (kind: ContactKind, value: string) =>
    lookups.some((l) =>
      ((kind === 'email' ? l.emails : l.phones) ?? []).some(
        (x) =>
          typeof x?.value === 'string' && sameContact(kind, x.value, value),
      ),
    )
  const markedBad = (kind: ContactKind, value: string) =>
    feedback.some(
      (f) =>
        f.contact_kind === kind &&
        f.verdict === 'bad' &&
        sameContact(kind, f.contact_value, value),
    )
  const got = answer.fromStore
  const newKinds = kinds.filter((kind) =>
    usableValuesOf(got, kind).some(
      (v) => !shownBefore(kind, v.value) && !markedBad(kind, v.value),
    ),
  )
  // The row: what it held plus what the store gave now (no duplicates).
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
  // Nothing to change: a store outage on a row that already holds values.
  if (!(unavailable && existing && existing.status === 'found' && !got)) {
    await store(
      admin,
      candidate,
      'contact_store',
      {
        status,
        emails,
        phones,
        error:
          status === 'error' ? 'The contact store could not be reached.' : null,
      },
      callerId,
      dashboardId,
    )
  }
  return { missing: answer.missing, newKinds }
}

/**
 * Lyca's own vendors for `kinds`, in order: SalesQL (once per person), then
 * BetterContact for each kind SalesQL left without a usable value (once per
 * kind). Whatever they find goes to the shared store (in the background).
 *
 * `findAnother` ("Find another", after a 👎 on a store or SalesQL value): the
 * next vendor not yet asked for the kind is asked even though other values of
 * that kind are still shown — SalesQL if it never ran (and BetterContact after
 * it when SalesQL brought nothing new, as there is nothing to 👎), otherwise
 * BetterContact.
 */
async function runVendors(
  admin: Admin,
  candidate: DashboardCandidate,
  kinds: ContactKind[],
  sales: LookupRow | null,
  backup: LookupRow | null,
  callerId: string,
  dashboardId: string,
  findAnother = false,
) {
  const salesqlReady = vendorConfigured('salesql')
  const backupReady = vendorConfigured('bettercontact')
  if (!salesqlReady && !backupReady) {
    throw new HttpError(503, 'Contact lookup is not configured.')
  }

  // What SalesQL gave, minus values the workspace marked 👎 (and, for
  // "Find another", minus values already shown).
  const { lookups, feedback } = await rowsFor(admin, [candidate.linkedinKey])
  const shown = (kind: ContactKind, value: string) =>
    lookups.some((l) =>
      ((kind === 'email' ? l.emails : l.phones) ?? []).some(
        (x) =>
          typeof x?.value === 'string' &&
          contactId(kind, x.value) === contactId(kind, value),
      ),
    )
  const bad = (kind: ContactKind, value: string) =>
    feedback.some(
      (f) =>
        f.contact_kind === kind &&
        f.verdict === 'bad' &&
        contactId(kind, f.contact_value) === contactId(kind, value),
    )
  // Usable: not marked 👎 here, and not called invalid by its own vendor
  // (a SalesQL "Invalid" email, an is_valid:false phone), so the next vendor
  // is asked for that kind.
  type Found = {
    emails: Array<{ value: string; status?: string | null }>
    phones: Array<{ value: string; valid?: boolean | null }>
  }
  const usableFrom = (found: Found) => ({
    emails: found.emails.filter(
      (e) => !bad('email', e.value) && !isInvalid('email', e),
    ),
    phones: found.phones.filter(
      (p) => !bad('phone', p.value) && !isInvalid('phone', p),
    ),
  })

  const newFrom = (found: Found) => {
    const usable = usableFrom(found)
    return {
      emails: usable.emails.filter((e) => !shown('email', e.value)),
      phones: usable.phones.filter((p) => !shown('phone', p.value)),
    }
  }

  let stillMissing = kinds
  if (sales && sales.status !== 'error') {
    // SalesQL was already asked: "Find another" goes to BetterContact.
    stillMissing = findAnother ? kinds : kindsMissing(usableFrom(sales), kinds)
  } else if (salesqlReady) {
    await enforceLimit(admin, callerId)
    // One SalesQL call per person at a time (claims.ts): a second request for
    // the same person waits for this answer instead of paying again.
    const claim = await onceAtATime(
      supabaseClaims(admin),
      candidate.linkedinKey,
      'salesql',
      async () => {
        // Under the claim, the saved answer first: a request that held it a
        // moment ago may have just paid.
        const fresh = await vendorRow(admin, candidate.linkedinKey, 'salesql')
        if (fresh && fresh.status !== 'error') return asResult(fresh)
        const result = await salesqlLookup(candidate)
        const saved = await store(
          admin,
          candidate,
          'salesql',
          result,
          callerId,
          dashboardId,
        )
        // What SalesQL found goes to the shared store, so no platform pays
        // for it again — in the background, so the reveal never waits on the
        // store. Marked synced when it lands; if not, contact-store-sync sends it.
        if (result.status === 'found') {
          contactStoreSaveLater(
            candidate.linkedinUrl,
            'salesql',
            result,
            markLookupSynced(admin, saved),
          )
        }
        return result
      },
    )
    // Another request paid: use its saved answer (never pay again here). An
    // error answer, or none within the wait, ends this request; the panel
    // offers "Try again".
    const result = claim.ran
      ? claim.value
      : asResult(await vendorRow(admin, candidate.linkedinKey, 'salesql'))
    if (!claim.ran && (!result || result.status === 'error')) return
    if (!result) return
    stillMissing =
      result.status === 'error'
        ? kinds
        : kindsMissing(
            findAnother ? newFrom(result) : usableFrom(result),
            kinds,
          )
  }

  // BetterContact for what is still missing, each kind at most once per person.
  const wanted = stillMissing.filter((k) =>
    k === 'email' ? !backup?.email_searched : !backup?.phone_searched,
  )
  if (!wanted.length || !backupReady) return
  if (backup?.status === 'pending') return // already searching; 'refresh' polls it
  await enforceLimit(admin, callerId)
  // One BetterContact search per person at a time (claims.ts). A request that
  // loses the claim waits for the winner's saved answer and pays nothing.
  await onceAtATime(
    supabaseClaims(admin),
    candidate.linkedinKey,
    'bettercontact',
    async () => {
      // Under the claim, the saved row again: what was searched meanwhile is not bought twice.
      const fresh = await vendorRow(
        admin,
        candidate.linkedinKey,
        'bettercontact',
      )
      if (fresh?.status === 'pending') return
      const still = wanted.filter((k) =>
        k === 'email' ? !fresh?.email_searched : !fresh?.phone_searched,
      )
      if (!still.length) return
      const result = await betterContactLookup(candidate, still)
      await storeBackup(
        admin,
        candidate,
        fresh,
        still,
        result,
        callerId,
        dashboardId,
      )
    },
  )
}

/** The person's saved row of one source (fresh from the database). */
async function vendorRow(
  admin: Admin,
  key: string,
  vendor: Source,
): Promise<LookupRow | null> {
  const { lookups } = await rowsFor(admin, [key])
  return lookups.find((l) => l.vendor === vendor) ?? null
}

/** A saved row as a vendor answer. */
function asResult(row: LookupRow | null): VendorResult | null {
  if (!row) return null
  return {
    status: row.status,
    emails: row.emails ?? [],
    phones: row.phones ?? [],
  }
}

/** Merges a backup answer for `kinds` into the person's backup row, keeping
 * whatever an earlier search of the OTHER kind already found. */
async function storeBackup(
  admin: Admin,
  candidate: DashboardCandidate,
  existing: LookupRow | null,
  kinds: ContactKind[],
  result: VendorResult,
  callerId: string,
  dashboardId: string,
) {
  const asksEmail = kinds.includes('email')
  const asksPhone = kinds.includes('phone')
  const done = result.status === 'found' || result.status === 'not_found'
  const emails = asksEmail && done ? result.emails : (existing?.emails ?? [])
  const phones = asksPhone && done ? result.phones : (existing?.phones ?? [])
  const status: VendorResult['status'] =
    result.status === 'pending'
      ? 'pending'
      : emails.length || phones.length
        ? 'found'
        : result.status === 'error'
          ? 'error'
          : 'not_found'

  const saved = await upsertUnsynced(
    admin,
    'candidate_contact_lookups',
    {
      linkedin_key: candidate.linkedinKey,
      linkedin_url: candidate.linkedinUrl,
      vendor: 'bettercontact',
      status,
      emails,
      phones,
      email_searched:
        (existing?.email_searched ?? false) || (asksEmail && done),
      phone_searched:
        (existing?.phone_searched ?? false) || (asksPhone && done),
      pending_kinds: result.status === 'pending' ? kinds : null,
      vendor_request_id:
        result.requestId ?? existing?.vendor_request_id ?? null,
      error: result.status === 'error' ? (result.error ?? null) : null,
      credits_used: result.creditsUsed ?? null,
      dashboard_id: dashboardId,
      candidate_name: candidate.name,
      requested_by: callerId,
    },
    'linkedin_key,vendor',
  )
  // The row's values go to the shared store (in the background): all of them,
  // not only this search's kind, so marking the row synced never skips a
  // value an earlier send failed to deliver (a value the store holds is not
  // duplicated). Marked when it lands; if not, contact-store-sync sends it.
  if (result.status === 'found' && (emails.length || phones.length)) {
    contactStoreSaveLater(
      candidate.linkedinUrl,
      'bettercontact',
      { emails, phones },
      markLookupSynced(admin, saved),
    )
  }
}

async function saveFeedback(
  admin: Admin,
  candidate: DashboardCandidate,
  payload: Record<string, unknown>,
  callerId: string,
  dashboardId: string,
) {
  const kind =
    payload.kind === 'email' || payload.kind === 'phone' ? payload.kind : null
  const verdict =
    payload.verdict === 'good' || payload.verdict === 'bad'
      ? payload.verdict
      : null
  const value = typeof payload.value === 'string' ? payload.value : ''
  const reason =
    typeof payload.reason === 'string' && REASONS.has(payload.reason)
      ? payload.reason
      : null
  if (!kind || !value) throw new HttpError(400, 'kind and value are required')

  const { lookups, feedback } = await rowsFor(admin, [candidate.linkedinKey])
  // Compared in the shared format: the value clicked may be spelled
  // differently from the row that holds it (flow.ts contactId).
  const owner = lookups.find((l) =>
    ((kind === 'email' ? l.emails : l.phones) ?? []).some(
      (x) => typeof x?.value === 'string' && sameContact(kind, x.value, value),
    ),
  )
  // The verdict rows already held for this number / address, any spelling.
  const heldSpellings = feedback
    .filter(
      (f) =>
        f.contact_kind === kind && sameContact(kind, f.contact_value, value),
    )
    .map((f) => f.contact_value)
  if (!owner)
    throw new HttpError(
      404,
      'That contact detail is not on record for this candidate.',
    )
  // 👍/👎 only where the panel shows it: store values, and SalesQL values
  // while BetterContact has not been asked for that kind; never BetterContact
  // values (flow.ts). Clearing an old verdict is still allowed.
  const personRows: PersonRows = {
    shared: lookups.find((l) => l.vendor === 'contact_store'),
    salesql: lookups.find((l) => l.vendor === 'salesql'),
    bettercontact: lookups.find((l) => l.vendor === 'bettercontact'),
  }
  if (verdict && !takesFeedback(kind, value, personRows)) {
    throw new HttpError(400, 'Feedback is not taken on this contact.')
  }

  if (!verdict) {
    // Clicking the same thumb again clears it.
    const { error } = await admin
      .from('candidate_contact_feedback')
      .delete()
      .eq('linkedin_key', candidate.linkedinKey)
      .eq('contact_kind', kind)
      .in('contact_value', [...new Set([value, ...heldSpellings])])
    if (error) throw error
    return
  }

  const saved = await upsertUnsynced(
    admin,
    'candidate_contact_feedback',
    {
      linkedin_key: candidate.linkedinKey,
      contact_kind: kind,
      // One verdict row per number: the spelling already held, if any.
      contact_value: heldSpellings[0] ?? value,
      vendor: owner.vendor,
      verdict,
      reason: verdict === 'bad' ? reason : null,
      dashboard_id: dashboardId,
      candidate_name: candidate.name,
      created_by: callerId,
      updated_by: callerId,
    },
    'linkedin_key,contact_kind,contact_value',
  )
  // Shared with every platform: a 👎 here stops others being shown a dead
  // contact. In the background, so the 👍/👎 never waits on the store. Marked
  // synced when it lands; if not, contact-store-sync sends it later.
  contactStoreFeedbackLater(
    candidate.linkedinUrl,
    kind,
    value,
    verdict,
    verdict === 'bad' ? reason : null,
    () =>
      markSynced(
        admin,
        'candidate_contact_feedback',
        saved.id,
        saved.updated_at,
      ),
    // When the 👍/👎 was saved: a later re-send of it (the sync job, a retry)
    // can then never undo a newer verdict in the store.
    saved.updated_at,
  )
}
