// Dashboard Analytics — server-side only, strictly read-only.
//
// Mirrors dashboard-assignments' shape (caller identity + role verified from
// a real session before anything runs; service-role client only reached
// after that) for the same reason: RLS alone can't safely serve this data.
// dashboard_assignments_select only lets a caller see their OWN assignment
// row (`user_id = auth.uid() or is_super_admin()`) — an Admin has no RLS
// path to the full assignee roster for a dashboard they manage, so the
// roster counts below require a service-role read, gated by our own
// authorization check, exactly like dashboard-assignments' `list` action
// already does for the same reason.
//
// Access rules (mirrors the product spec, updated 2026-09-04 to match the
// widened dashboard visibility — analytics access always equals dashboard
// visibility, so a role can never open a dashboard it can't get analytics
// for, or vice versa):
//   super_admin — analytics for any dashboard, unconditionally.
//   admin       — analytics for any dashboard, matching their dashboard
//                 visibility (Admins see every dashboard). Read-only, like
//                 everything here — no new edit/delete/assignment power.
//   viewer      — only a dashboard they are assigned to (checked fresh
//                 against dashboard_assignments on every call, never
//                 trusted from the request), which is exactly the set they
//                 can see at all. Same numbers, same response shape for
//                 every role — the analytics themselves are never scoped.
// Single-tenant deployment: no tenant column exists anywhere, so "any
// dashboard" means any in this instance — there is no cross-tenant surface.
//
// No writes happen anywhere in this function — it never touches dashboards,
// dashboard_assignments, dashboard_status, or storage except to read.

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

const MAX_BODY_BYTES = 1_000

type CallerRole = 'super_admin' | 'admin' | 'viewer'
type SupabaseClient = ReturnType<typeof createClient>

interface GetPayload {
  dashboardId: string
}

/** Minimal, deliberately non-sensitive identity shown in the Assigned Users
 * list — name (falling back to email when unset) and email only, never role
 * internals, timestamps, or anything else off the profile row. */
interface AssignedUserSummary {
  id: string
  name: string | null
  email: string
}

type ActionBody =
  { action: 'get'; payload: GetPayload } | { action: 'overview' }

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
    .select('role, name, email')
    .eq('id', caller.id)
    .maybeSingle()

  const callerRole = callerProfile?.role as CallerRole | undefined

  if (callerProfileError || !callerRole) {
    return json({ error: 'Forbidden' }, 403, cors)
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
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors)
  }

  const callerIdentity: AssignedUserSummary = {
    id: caller.id,
    name: (callerProfile?.name as string | null) ?? null,
    email: (callerProfile?.email as string) ?? caller.email ?? '',
  }

  try {
    switch (body.action) {
      case 'get':
        return await getAnalytics(
          admin,
          body.payload,
          callerIdentity,
          callerRole,
          cors,
        )
      case 'overview':
        return await getOverview(admin, callerIdentity, callerRole, cors)
      default:
        return json({ error: 'Unknown action' }, 400, cors)
    }
  } catch (err) {
    console.error('dashboard-analytics error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500, cors)
  }
})

interface DashboardRow {
  id: string
  title: string
  storage_path: string
}

async function getDashboard(
  admin: SupabaseClient,
  dashboardId: string,
): Promise<DashboardRow | null> {
  const { data } = await admin
    .from('dashboards')
    .select('id, title, storage_path')
    .eq('id', dashboardId)
    .maybeSingle<DashboardRow>()
  return data ?? null
}

async function isAssigned(
  admin: SupabaseClient,
  dashboardId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await admin
    .from('dashboard_assignments')
    .select('id')
    .eq('dashboard_id', dashboardId)
    .eq('user_id', userId)
    .maybeSingle()
  return Boolean(data)
}

async function getAnalytics(
  admin: SupabaseClient,
  payload: GetPayload,
  caller: AssignedUserSummary,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { dashboardId } = payload ?? ({} as GetPayload)
  if (!dashboardId) {
    return json({ error: 'dashboardId is required.' }, 400, cors)
  }

  const dashboard = await getDashboard(admin, dashboardId)
  if (!dashboard) return json({ error: 'Dashboard not found.' }, 404, cors)

  // Viewer only: an assignment row is required, checked fresh on every
  // call. Super Admin AND Admin skip this — their analytics access equals
  // their dashboard visibility (every dashboard), per the 2026-09-04 rule
  // in the module comment.
  if (
    callerRole === 'viewer' &&
    !(await isAssigned(admin, dashboardId, caller.id))
  ) {
    return json(
      { error: 'You can only view analytics for dashboards assigned to you.' },
      403,
      cors,
    )
  }

  const [assignedUsers, actionBreakdown, candidateTotal] = await Promise.all([
    getAssignedUsers(admin, dashboardId, callerRole, caller),
    getActionBreakdown(admin, dashboardId),
    getTotalCandidates(admin, dashboard.storage_path),
  ])

  const actioned = actionBreakdown.reduce((sum, entry) => sum + entry.count, 0)
  const pending =
    candidateTotal === null ? null : Math.max(0, candidateTotal - actioned)

  return json(
    {
      dashboard: { id: dashboard.id, title: dashboard.title },
      assignedUsers,
      candidates: {
        total: candidateTotal,
        actioned,
        pending,
      },
      actionBreakdown,
    },
    200,
    cors,
  )
}

interface AssignedUsersPayload {
  total: number
  /** The CALLING Super Admin's own identity — sourced from their verified
   * session/profile, never from a dashboard_assignments row (a Super Admin
   * doesn't need one to have full access; see the module comment). Null for
   * an Admin or Viewer caller — only a Super Admin ever sees the Super
   * Admin here at all. */
  superAdmin: AssignedUserSummary | null
  admins: AssignedUserSummary[]
  viewers: AssignedUserSummary[]
}

/** Dashboard-specific roster, split by role, for the CURRENT dashboard only
 * — one query against dashboard_assignments filtered by dashboard_id, same
 * table/shape listAssignments() in dashboard-assignments/index.ts already
 * reads for Manage Access, just grouped differently. An Admin or Viewer
 * only ever gets here after the isAssigned() check above already passed, so
 * nothing further needs filtering by caller — every row IS this dashboard's
 * roster. */
async function getAssignedUsers(
  admin: SupabaseClient,
  dashboardId: string,
  callerRole: CallerRole,
  caller: AssignedUserSummary,
): Promise<AssignedUsersPayload> {
  const { data, error } = await admin
    .from('dashboard_assignments')
    .select(
      'profiles!dashboard_assignments_user_id_fkey(id, name, email, role)',
    )
    .eq('dashboard_id', dashboardId)

  if (error) throw error

  const admins: AssignedUserSummary[] = []
  const viewers: AssignedUserSummary[] = []
  for (const row of data ?? []) {
    const profile = row.profiles as unknown as {
      id: string
      name: string | null
      email: string
      role: CallerRole
    } | null
    if (!profile) continue
    const summary: AssignedUserSummary = {
      id: profile.id,
      name: profile.name,
      email: profile.email,
    }
    if (profile.role === 'admin') admins.push(summary)
    else if (profile.role === 'viewer') viewers.push(summary)
    // A super_admin-role assignment row (rare — shared ownership) is
    // neither an Admin nor a Viewer and isn't the calling identity below,
    // so it's intentionally omitted from every bucket, same as before.
  }

  // "Do NOT query dashboard_assignments to find the Super Admin" — this is
  // the caller's own verified identity, passed in from the session check
  // that already ran before this function was ever called.
  const superAdmin = callerRole === 'super_admin' ? caller : null

  return {
    total: admins.length + viewers.length + (superAdmin ? 1 : 0),
    superAdmin,
    admins,
    viewers,
  }
}

// ---------------------------------------------------------------------------
// JD Analytics overview — one aggregated response covering EVERY dashboard
// the caller may see, so the JD Analytics page never issues one request per
// dashboard. Access follows the exact same rule as `get`: a Super Admin or
// Admin sees every dashboard; a Viewer sees only dashboards they hold a
// dashboard_assignments row on (the same set they can open at all). All
// numbers come from the same sources the per-dashboard analytics above
// uses — dashboard_status current-state rows (one per touched candidate)
// for the action counts and the stored HTML for the candidate total — so
// the two views can never disagree. Batched: one dashboards query, one
// dashboard_status query, one profiles query, and the per-dashboard HTML
// reads in parallel.
//
// completedAt comes from the REQUIREMENT lifecycle: a Super Admin may link
// a requirement to its JD dashboard (requirements.dashboard_id, set only
// through the requirements Edge Function), and a dashboard's row shows the
// linked requirement's completion timestamp while that requirement's
// CURRENT status is 'Completed'. Dashboards with no such link stay null
// and render as "—" — never a guessed date.
// ---------------------------------------------------------------------------

interface OverviewDashboardRow {
  id: string
  title: string
  created_by: string | null
  created_at: string
  storage_path: string
}

async function getOverview(
  admin: SupabaseClient,
  caller: AssignedUserSummary,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  let dashboards: OverviewDashboardRow[] = []

  // Super Admin and Admin: every dashboard — the same set their dashboard
  // list shows. Viewer: assigned only, unchanged.
  if (callerRole === 'super_admin' || callerRole === 'admin') {
    const { data, error } = await admin
      .from('dashboards')
      .select('id, title, created_by, created_at, storage_path')
      .order('created_at', { ascending: false })
    if (error) throw error
    dashboards = (data ?? []) as OverviewDashboardRow[]
  } else {
    const { data: assignments, error: assignmentsError } = await admin
      .from('dashboard_assignments')
      .select('dashboard_id')
      .eq('user_id', caller.id)
    if (assignmentsError) throw assignmentsError
    const ids = [
      ...new Set(
        (assignments ?? []).map(
          (row) => (row as { dashboard_id: string }).dashboard_id,
        ),
      ),
    ]
    if (ids.length > 0) {
      const { data, error } = await admin
        .from('dashboards')
        .select('id, title, created_by, created_at, storage_path')
        .in('id', ids)
        .order('created_at', { ascending: false })
      if (error) throw error
      dashboards = (data ?? []) as OverviewDashboardRow[]
    }
  }

  if (dashboards.length === 0) {
    return json({ rows: [] }, 200, cors)
  }

  const dashboardIds = dashboards.map((d) => d.id)

  // One query for every action row across all visible dashboards, grouped
  // in memory — the same per-candidate current-state source
  // getActionBreakdown reads, just batched.
  const { data: statusRows, error: statusError } = await admin
    .from('dashboard_status')
    .select('dashboard_id, action')
    .in('dashboard_id', dashboardIds)
    .not('action', 'is', null)
  if (statusError) throw statusError

  const breakdownByDashboard = new Map<string, Map<string, number>>()
  for (const row of statusRows ?? []) {
    const { dashboard_id, action } = row as {
      dashboard_id: string
      action: string | null
    }
    if (!action) continue
    let counts = breakdownByDashboard.get(dashboard_id)
    if (!counts) {
      counts = new Map()
      breakdownByDashboard.set(dashboard_id, counts)
    }
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }

  // One query for every creator identity (same minimal fields the Assigned
  // Users list already exposes).
  const creatorIds = [
    ...new Set(dashboards.map((d) => d.created_by).filter(Boolean)),
  ] as string[]
  const creatorsById = new Map<string, AssignedUserSummary>()
  if (creatorIds.length > 0) {
    const { data: creators, error: creatorsError } = await admin
      .from('profiles')
      .select('id, name, email')
      .in('id', creatorIds)
    if (creatorsError) throw creatorsError
    for (const profile of creators ?? []) {
      const p = profile as { id: string; name: string | null; email: string }
      creatorsById.set(p.id, { id: p.id, name: p.name, email: p.email })
    }
  }

  // Candidate totals come from each dashboard's stored HTML — the only
  // place candidates exist (see getTotalCandidates). Read in parallel,
  // once per dashboard per request, exactly like the per-dashboard
  // analytics does for one.
  const totals = await Promise.all(
    dashboards.map((d) => getTotalCandidates(admin, d.storage_path)),
  )

  // Completed Date comes from the REQUIREMENT lifecycle, joined through
  // the explicit requirements.dashboard_id link a Super Admin sets — one
  // query for all visible dashboards. Only a requirement whose CURRENT
  // status is 'Completed' contributes (display gates on status, same as
  // everywhere else); if several completed requirements link to one
  // dashboard, the latest completion wins, matching the live stamping
  // rule. Dashboards with no linked completed requirement stay null ("—").
  const { data: linkedReqs, error: linkedError } = await admin
    .from('requirements')
    .select('dashboard_id, status, completed_at')
    .in('dashboard_id', dashboardIds)
    .eq('status', 'Completed')
    .not('completed_at', 'is', null)
  if (linkedError) throw linkedError
  const completedByDashboard = new Map<string, string>()
  for (const req of linkedReqs ?? []) {
    const { dashboard_id, completed_at } = req as {
      dashboard_id: string
      completed_at: string
    }
    const current = completedByDashboard.get(dashboard_id)
    if (!current || completed_at > current) {
      completedByDashboard.set(dashboard_id, completed_at)
    }
  }

  const rows = dashboards.map((dashboard, index) => {
    const counts = breakdownByDashboard.get(dashboard.id)
    const actionBreakdown = counts
      ? [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count)
      : []
    const actioned = actionBreakdown.reduce(
      (sum, entry) => sum + entry.count,
      0,
    )
    const total = totals[index]
    const pending = total === null ? null : Math.max(0, total - actioned)
    return {
      id: dashboard.id,
      title: dashboard.title,
      createdBy: dashboard.created_by
        ? (creatorsById.get(dashboard.created_by) ?? null)
        : null,
      createdAt: dashboard.created_at,
      completedAt: completedByDashboard.get(dashboard.id) ?? null,
      candidates: { total, actioned, pending },
      actionBreakdown,
    }
  })

  return json({ rows }, 200, cors)
}

interface ActionBreakdownEntry {
  /** The raw stored value, e.g. "Screen Select - HireSense" — never a
   * hardcoded allowlist, so any current or future valid action value is
   * supported automatically without a code change here. */
  value: string
  count: number
}

/** Single SELECT of just the `action` column for this dashboard, grouped in
 * memory. Deliberately not a bespoke SQL aggregate: dashboard_status is
 * already a bounded, one-row-per-touched-candidate table (never one row per
 * candidate field, never re-fetched per candidate), so this is one query
 * regardless of dashboard size — not the N+1 pattern the spec warns against. */
async function getActionBreakdown(
  admin: SupabaseClient,
  dashboardId: string,
): Promise<ActionBreakdownEntry[]> {
  const { data, error } = await admin
    .from('dashboard_status')
    .select('action')
    .eq('dashboard_id', dashboardId)
    .not('action', 'is', null)

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of data ?? []) {
    const value = (row as { action: string | null }).action
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Total candidate count — the one number this schema has no table for.
// Candidates live entirely inside the dashboard's own uploaded HTML (a
// generator-embedded JSON blob), never in Postgres; dashboard_status only
// ever gets a row once a candidate's status/action is first touched by a
// user. So "how many candidates does this dashboard have" can only be
// answered by reading that HTML — done here, server-side, ONCE per
// analytics request (not per candidate), mirroring the two embedded-data
// shapes already documented as the real-world formats in
// src/lib/htmlNormalization/validate.ts's CANDIDATE_DATA_MARKERS:
//   - `const PAYLOAD = {"cand": [...], ...}` — every real dashboard sampled
//     from Storage this cycle uses this shape.
//   - `window.__D = {"candidates": [...], ...}` — the originally documented
//     shape, kept as a fallback in case another dashboard family uses it.
// Returns null (never throws, never guesses) if neither shape is found, so
// the caller can show "unavailable" instead of a wrong number.
// ---------------------------------------------------------------------------

function findMatchingBracket(str: string, openIdx: number): number {
  const openCh = str[openIdx]
  const closeCh = openCh === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function countJsonArrayAfterKey(html: string, key: string): number | null {
  const keyIdx = html.indexOf(`"${key}"`)
  if (keyIdx === -1) return null
  const arrOpenIdx = html.indexOf('[', keyIdx)
  if (arrOpenIdx === -1) return null
  const arrCloseIdx = findMatchingBracket(html, arrOpenIdx)
  if (arrCloseIdx === -1) return null
  try {
    const parsed = JSON.parse(html.slice(arrOpenIdx, arrCloseIdx + 1))
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

async function getTotalCandidates(
  admin: SupabaseClient,
  storagePath: string,
): Promise<number | null> {
  const { data, error } = await admin.storage
    .from('dashboards')
    .download(storagePath)
  if (error || !data) return null

  const html = await data.text()

  // Primary: the shape every real dashboard sampled from Storage uses.
  const cand = countJsonArrayAfterKey(html, 'cand')
  if (cand !== null) return cand

  // Fallback: the originally documented window.__D.candidates shape.
  const candidates = countJsonArrayAfterKey(html, 'candidates')
  if (candidates !== null) return candidates

  // Last resort: the generic-table row template every generator variant
  // seen so far renders one of these per candidate row.
  const rowMatches = html.match(/<tr class="row" data-i="/g)
  if (rowMatches) return rowMatches.length

  return null
}
