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
// Backup rule — nothing automatic, every vendor call is a click:
//   "Get contact" ('lookup')  -> the shared contact store first (contact-store.ts:
//                                what any HireSense platform revealed, then
//                                ZipLabs); only if it has nothing, SalesQL.
//                                Unconfigured or unreachable: SalesQL, as before.
//                                SalesQL / BetterContact answers and every 👍/👎
//                                are written back to the store.
//   'backup' + kinds          -> BetterContact for just those kinds, offered
//                                per kind when SalesQL found none of that kind
//                                or one was marked 👎 ("Find phone number",
//                                "Find another email"). Each kind is bought
//                                from the backup at most once per person.
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
  contactStoreFeedback,
  contactStoreLookup,
  contactStoreSave,
} from './contact-store.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://adobe-longlist.vercel.app',
  'https://longlist.hiresense.ai',
])

const MAX_BODY_BYTES = 4_000
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
        // Only records the verdict. A 👎 makes the panel offer "Find
        // another email" / "Find phone number" — it never calls a vendor.
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
  const verdictOf = (k: string, kind: string, value: string) =>
    feedback.find(
      (f) =>
        f.linkedin_key === k &&
        f.contact_kind === kind &&
        f.contact_value === value,
    ) ?? null

  const backupReady = vendorConfigured('bettercontact')
  const out = []
  for (const c of candidates) {
    const mine = lookups.filter((l) => l.linkedin_key === c.linkedinKey)
    if (!mine.length) continue
    const sales = mine.find((l) => l.vendor === 'salesql')
    const backup = mine.find((l) => l.vendor === 'bettercontact')
    // An answer from the shared contact store counts as the lookup, like SalesQL's.
    const shared = mine.find((l) => l.vendor === 'contact_store')
    const lookedUp =
      (!!sales && sales.status !== 'error') || shared?.status === 'found'

    // One list per kind, primary source first, duplicates dropped. Which
    // vendor a value came from is never sent to the dashboard.
    const merge = (kind: ContactKind) => {
      const seen = new Set<string>()
      const items = []
      for (const row of [shared, sales, backup]) {
        if (!row) continue
        for (const raw of kind === 'email' ? row.emails : row.phones) {
          const id = kind === 'email' ? raw.value.toLowerCase() : raw.value
          if (seen.has(id)) continue
          seen.add(id)
          const f = verdictOf(c.linkedinKey, kind, raw.value)
          const status = 'status' in raw ? raw.status : null
          items.push({
            value: raw.value,
            type: raw.type,
            verified:
              'valid' in raw
                ? raw.valid
                : status === 'Valid' || status === 'deliverable'
                  ? true
                  : status === 'Invalid' || status === 'undeliverable'
                    ? false
                    : null,
            verdict: f?.verdict ?? null,
            reason: f?.reason ?? null,
          })
        }
      }
      return items
    }
    const emails = merge('email')
    const phones = merge('phone')

    const kindState = (kind: ContactKind, items: typeof emails) => {
      const searched =
        kind === 'email' ? backup?.email_searched : backup?.phone_searched
      const searching =
        backup?.status === 'pending' && !!backup.pending_kinds?.includes(kind)
      const usable = items.filter((x) => x.verdict !== 'bad')
      return {
        searching,
        // Offered only when a click is useful: none of this kind yet, or one
        // marked 👎 — and the backup hasn't been asked for this kind before.
        canFind:
          backupReady &&
          lookedUp &&
          !searched &&
          !searching &&
          (!items.length || items.some((x) => x.verdict === 'bad')),
        exhausted: !!searched && !usable.length,
      }
    }

    out.push({
      candidateName: c.name,
      linkedinUrl: c.linkedinUrl,
      lookedUp,
      error:
        sales?.status === 'error'
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

async function store(
  admin: Admin,
  candidate: DashboardCandidate,
  vendor: Source,
  result: VendorResult,
  callerId: string,
  dashboardId: string,
) {
  const { error } = await admin.from('candidate_contact_lookups').upsert(
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
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'linkedin_key,vendor' },
  )
  if (error) throw error
}

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
    // Only kinds not already bought from the backup for this person.
    const wanted = kinds.filter((k) =>
      k === 'email' ? !backup?.email_searched : !backup?.phone_searched,
    )
    if (!wanted.length) return
    if (!vendorConfigured('bettercontact')) {
      throw new HttpError(503, 'The backup contact source is not configured.')
    }
    await enforceLimit(admin, callerId)
    const result = await betterContactLookup(candidate, wanted)
    await storeBackup(
      admin,
      candidate,
      backup,
      wanted,
      result,
      callerId,
      dashboardId,
    )
    return
  }

  // "Get contact": the primary source only — never the backup by itself.
  if (sales && sales.status !== 'error') return // already looked up
  const shared = lookups.find((l) => l.vendor === 'contact_store')
  if (shared?.status === 'found') return // already answered by the shared store

  // The shared contact store first: contacts any HireSense platform already
  // revealed, then ZipLabs. Only when it has nothing does SalesQL run. If it
  // can't be reached, the lookup goes on to SalesQL exactly as before.
  if (contactStoreConfigured()) {
    await enforceLimit(admin, callerId)
    try {
      const fromStore = await contactStoreLookup(candidate.linkedinUrl)
      if (fromStore.status === 'found') {
        await store(
          admin,
          candidate,
          'contact_store',
          fromStore,
          callerId,
          dashboardId,
        )
        return
      }
    } catch (err) {
      console.warn(
        'contact store unavailable, using SalesQL:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  if (!vendorConfigured('salesql'))
    throw new HttpError(503, 'Contact lookup is not configured.')
  await enforceLimit(admin, callerId)
  const result = await salesqlLookup(candidate)
  await store(admin, candidate, 'salesql', result, callerId, dashboardId)
  // What SalesQL found goes to the shared store, so no platform pays for it again.
  if (result.status === 'found') {
    await contactStoreSave(candidate.linkedinUrl, 'salesql', result)
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

  const { error } = await admin.from('candidate_contact_lookups').upsert(
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
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'linkedin_key,vendor' },
  )
  if (error) throw error
  // What the backup found for the kinds asked goes to the shared store.
  if (result.status === 'found') {
    await contactStoreSave(candidate.linkedinUrl, 'bettercontact', {
      emails: asksEmail ? result.emails : [],
      phones: asksPhone ? result.phones : [],
    })
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

  const { lookups } = await rowsFor(admin, [candidate.linkedinKey])
  const owner = lookups.find((l) =>
    (kind === 'email' ? l.emails : l.phones).some((x) => x.value === value),
  )
  if (!owner)
    throw new HttpError(
      404,
      'That contact detail is not on record for this candidate.',
    )

  if (!verdict) {
    // Clicking the same thumb again clears it.
    const { error } = await admin
      .from('candidate_contact_feedback')
      .delete()
      .eq('linkedin_key', candidate.linkedinKey)
      .eq('contact_kind', kind)
      .eq('contact_value', value)
    if (error) throw error
    return
  }

  const now = new Date().toISOString()
  const { error } = await admin.from('candidate_contact_feedback').upsert(
    {
      linkedin_key: candidate.linkedinKey,
      contact_kind: kind,
      contact_value: value,
      vendor: owner.vendor,
      verdict,
      reason: verdict === 'bad' ? reason : null,
      dashboard_id: dashboardId,
      candidate_name: candidate.name,
      created_by: callerId,
      updated_by: callerId,
      updated_at: now,
    },
    { onConflict: 'linkedin_key,contact_kind,contact_value' },
  )
  if (error) throw error
  // Shared with every platform: a 👎 here stops others being shown a dead contact.
  await contactStoreFeedback(
    candidate.linkedinUrl,
    kind,
    value,
    verdict,
    verdict === 'bad' ? reason : null,
  )
}
