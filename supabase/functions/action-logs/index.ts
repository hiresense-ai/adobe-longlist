// Action Logs — Super Admin only, read-only.
//
// candidate_action_logs (see 20260918000001_candidate_action_logs.sql) has
// NO client-reachable RLS policy at all — not even SELECT — by design: it
// is sensitive audit history, and that migration deliberately left reading
// it unimplemented until a real read feature needed it ("add one
// deliberately when a real read feature is built, scoped to whatever that
// feature actually needs"). This function IS that feature: it verifies the
// caller's session and profile role BEFORE touching anything, refuses
// anyone but a Super Admin with 403, and only then reads through a
// service-role client — the same "verified identity first, service-role
// second" shape as dashboard-analytics, dashboard-edit, and requirements.
// Admin and Viewer have no path to this data at all, direct table access
// included, since RLS denies them regardless of this function's own check.
//
// Server-side pagination and filtering (search/dashboard/user/action/date
// range) is a deliberate departure from every other list-style endpoint in
// this app, which fetch everything once and filter/sort/paginate
// client-side (e.g. JD Analytics' overview — "pagination-proof by
// construction" because the whole set is already in memory). The audit log
// has no such ceiling: it grows without bound as candidate actions keep
// changing, so fetching the entire table on every page view would only get
// slower over time. This is the one endpoint where that tradeoff is made on
// purpose.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://adobe-longlist.vercel.app',
  'https://longlist.hiresense.ai',
])

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

const MAX_BODY_BYTES = 2_000
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 25

type CallerRole = 'super_admin' | 'admin' | 'viewer'
type SupabaseClient = ReturnType<typeof createClient>

interface ListPayload {
  search?: string
  dashboardId?: string
  changedBy?: string
  action?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
  sortDir?: 'asc' | 'desc'
}

type ActionBody = { action: 'list'; payload?: ListPayload }

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401, cors)
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser()

  if (callerError || !caller) {
    return json({ error: 'Invalid session' }, 401, cors)
  }

  const { data: callerProfile, error: callerProfileError } = await callerClient
    .from('profiles')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle()

  const callerRole = callerProfile?.role as CallerRole | undefined

  if (callerProfileError || !callerRole) {
    return json({ error: 'Forbidden' }, 403, cors)
  }

  // Super Admin only — checked from the verified session role, never from
  // the request. Admin and Viewer are refused here regardless of how the
  // request is shaped, matching every other role check in this app.
  if (callerRole !== 'super_admin') {
    return json(
      { error: 'Action Logs is available to Super Admins only.' },
      403,
      cors,
    )
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body too large' }, 413, cors)
  }

  let body: ActionBody
  try {
    body = rawBody ? JSON.parse(rawBody) : { action: 'list' }
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors)
  }

  try {
    switch (body.action) {
      case 'list':
        return await listActionLogs(admin, body.payload ?? {}, cors)
      default:
        return json({ error: 'Unknown action' }, 400, cors)
    }
  } catch (err) {
    console.error('action-logs error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500, cors)
  }
})

interface LogRow {
  id: string
  dashboard_id: string
  candidate_id: string
  previous_action: string | null
  new_action: string | null
  changed_by: string | null
  changed_at: string
  dashboards: { title: string } | { title: string }[] | null
  dashboard_status:
    { candidate_name: string } | { candidate_name: string }[] | null
  profiles:
    | { name: string | null; email: string }
    | { name: string | null; email: string }[]
    | null
}

/** PostgREST embeds a to-one relationship as either a single object or a
 * one-element array depending on how the relationship was inferred — this
 * normalizes both to a single value (or null) so callers never have to
 * care which shape came back. */
function one<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

async function listActionLogs(
  admin: SupabaseClient,
  payload: ListPayload,
  cors: Record<string, string>,
) {
  const page =
    Number.isInteger(payload.page) && (payload.page ?? 0) > 0
      ? payload.page!
      : 1
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Number.isInteger(payload.pageSize) && (payload.pageSize ?? 0) > 0
      ? payload.pageSize!
      : DEFAULT_PAGE_SIZE,
  )
  const sortAscending = payload.sortDir === 'asc'

  // The search box matches candidate name, dashboard/JD title, and the
  // changed-by user's name/email — none of which live on
  // candidate_action_logs itself. Resolved as a handful of targeted lookups
  // (never a per-row query — see the module comment on why this endpoint
  // exists at all) into id lists, then combined into ONE .or() against the
  // main table. A search matching nothing short-circuits before touching
  // candidate_action_logs, rather than building an .or() with empty
  // `in.()` lists (invalid PostgREST syntax) or one that could accidentally
  // match everything.
  let candidateIds: string[] | null = null
  let dashboardIdsFromSearch: string[] | null = null
  let userIdsFromSearch: string[] | null = null

  const search = payload.search?.trim()
  if (search) {
    const like = `%${search}%`
    const [candidateRes, dashboardRes, byName, byEmail] = await Promise.all([
      admin.from('dashboard_status').select('id').ilike('candidate_name', like),
      admin.from('dashboards').select('id').ilike('title', like),
      admin.from('profiles').select('id').ilike('name', like),
      admin.from('profiles').select('id').ilike('email', like),
    ])
    if (candidateRes.error) throw candidateRes.error
    if (dashboardRes.error) throw dashboardRes.error
    if (byName.error) throw byName.error
    if (byEmail.error) throw byEmail.error

    candidateIds = (candidateRes.data ?? []).map((r) => r.id as string)
    dashboardIdsFromSearch = (dashboardRes.data ?? []).map(
      (r) => r.id as string,
    )
    userIdsFromSearch = [
      ...new Set([
        ...(byName.data ?? []).map((r) => r.id as string),
        ...(byEmail.data ?? []).map((r) => r.id as string),
      ]),
    ]

    if (
      candidateIds.length === 0 &&
      dashboardIdsFromSearch.length === 0 &&
      userIdsFromSearch.length === 0
    ) {
      return json({ data: [], page, pageSize, total: 0 }, 200, cors)
    }
  }

  let query = admin.from('candidate_action_logs').select(
    `id, dashboard_id, candidate_id, previous_action, new_action, changed_by, changed_at,
       dashboards!candidate_action_logs_dashboard_id_fkey(title),
       dashboard_status!candidate_action_logs_candidate_id_fkey(candidate_name),
       profiles!candidate_action_logs_changed_by_fkey(name, email)`,
    { count: 'exact' },
  )

  if (payload.dashboardId) query = query.eq('dashboard_id', payload.dashboardId)
  if (payload.changedBy) query = query.eq('changed_by', payload.changedBy)
  if (payload.action) query = query.eq('new_action', payload.action)
  if (payload.dateFrom) query = query.gte('changed_at', payload.dateFrom)
  if (payload.dateTo) query = query.lt('changed_at', payload.dateTo)

  if (search) {
    // Every id here came from our own just-run lookups above (always a
    // well-formed uuid string), never from the request directly — safe to
    // splice straight into the filter string with no further escaping.
    const clauses: string[] = []
    if (candidateIds!.length > 0) {
      clauses.push(`candidate_id.in.(${candidateIds!.join(',')})`)
    }
    if (dashboardIdsFromSearch!.length > 0) {
      clauses.push(`dashboard_id.in.(${dashboardIdsFromSearch!.join(',')})`)
    }
    if (userIdsFromSearch!.length > 0) {
      clauses.push(`changed_by.in.(${userIdsFromSearch!.join(',')})`)
    }
    query = query.or(clauses.join(','))
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order('changed_at', { ascending: sortAscending })
    .range(from, to)

  if (error) throw error

  const rows = (data ?? []) as unknown as LogRow[]
  const result = rows.map((row) => {
    const dashboard = one(row.dashboards)
    const candidate = one(row.dashboard_status)
    const changedByProfile = one(row.profiles)
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      dashboardTitle: dashboard?.title ?? null,
      candidateId: row.candidate_id,
      candidateName: candidate?.candidate_name ?? null,
      previousAction: row.previous_action,
      newAction: row.new_action,
      changedBy: row.changed_by,
      changedByName: changedByProfile?.name ?? null,
      changedByEmail: changedByProfile?.email ?? null,
      changedAt: row.changed_at,
    }
  })

  return json({ data: result, page, pageSize, total: count ?? 0 }, 200, cors)
}
