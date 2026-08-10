// Dashboard Assignment Management — server-side only.
//
// Mirrors admin-users' shape (caller identity + role verified from a real
// session before anything runs; service-role client only reached after
// that; every mutation rate-limited and audit-logged) because the same
// reasoning applies: this is the one place service-role writes to
// dashboard_assignments happen, so it's the one place that must get the
// authorization right — a hidden UI button is not the boundary.
//
// Rules (mirrors the product spec verbatim):
//   super_admin — any assignment: any dashboard, any target role, add or
//                 remove, including another admin's or super_admin's own
//                 assignment row.
//   admin       — may only act on a dashboard they themselves have a row
//                 in (checked fresh against the table on every call, never
//                 trusted from the request), may only add/remove a target
//                 whose profiles.role is 'viewer', and may never remove
//                 their OWN assignment row (that is "remove their own
//                 access", explicitly disallowed regardless of role).
//   viewer      — 403 on every action here. No assignment permissions at
//                 all, including just listing a roster.
//
// Deliberately NOT reachable while the caller has a pending
// force_password_change, same as admin-users and for the same reason: none
// of these actions are how a forced change gets completed, so none should
// be usable until it is.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Same allowlist as admin-users/auth-login — defense-in-depth only, the
// real gate is the JWT + role check below regardless of calling origin.
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

const MAX_BODY_BYTES = 4_000
const RATE_LIMIT_WINDOW_MINUTES = 10
const RATE_LIMIT_MAX_ACTIONS = 60

type CallerRole = 'super_admin' | 'admin' | 'viewer'

interface ListPayload {
  dashboardId: string
}
interface AssignPayload {
  dashboardId: string
  userId: string
}
interface UnassignPayload {
  dashboardId: string
  userId: string
}

type ActionBody =
  | { action: 'list'; payload: ListPayload }
  | { action: 'assign'; payload: AssignPayload }
  | { action: 'unassign'; payload: UnassignPayload }

type SupabaseClient = ReturnType<typeof createClient>

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

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const userAgent = req.headers.get('user-agent') ?? 'unknown'

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
    .select('role, force_password_change')
    .eq('id', caller.id)
    .maybeSingle()

  const callerRole = callerProfile?.role as CallerRole | undefined

  if (callerProfileError || !callerRole) {
    return json({ error: 'Forbidden' }, 403, cors)
  }

  // Viewer has zero assignment permissions — not even listing a roster.
  // Rejected here, before anything else, exactly as the spec states:
  // "If caller is Viewer: reject with HTTP 403 Forbidden."
  if (callerRole === 'viewer') {
    return json(
      { error: 'Viewers cannot manage dashboard assignments.' },
      403,
      cors,
    )
  }

  if (callerProfile?.force_password_change) {
    return json(
      {
        error: 'You must change your password before performing this action.',
      },
      403,
      cors,
    )
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  if (await isRateLimited(admin, caller.id)) {
    return json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      429,
      cors,
    )
  }

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

  try {
    switch (body.action) {
      case 'list':
        return await listAssignments(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'assign':
        return await assignDashboard(
          admin,
          body.payload,
          caller.id,
          callerRole,
          { ip, userAgent },
          cors,
        )
      case 'unassign':
        return await unassignDashboard(
          admin,
          body.payload,
          caller.id,
          callerRole,
          { ip, userAgent },
          cors,
        )
      default:
        return json({ error: 'Unknown action' }, 400, cors)
    }
  } catch (err) {
    console.error('dashboard-assignments error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500, cors)
  }
})

async function isRateLimited(
  admin: SupabaseClient,
  callerId: string,
): Promise<boolean> {
  const since = new Date(
    Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000,
  ).toISOString()
  const { count, error } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('actor_id', callerId)
    .like('action', 'dashboard.assignment_%')
    .gte('created_at', since)

  if (error) {
    console.error('rate limit check failed:', error)
    return false // fail open — a logging hiccup shouldn't block legitimate work
  }
  return (count ?? 0) >= RATE_LIMIT_MAX_ACTIONS
}

async function logAudit(
  admin: SupabaseClient,
  entry: {
    actorId: string
    action: string
    targetType?: string
    targetId?: string
    targetEmail?: string
    metadata?: Record<string, unknown>
    success: boolean
  },
) {
  const { error } = await admin.from('audit_logs').insert({
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    target_email: entry.targetEmail ?? null,
    metadata: entry.metadata ?? {},
    success: entry.success,
  })
  if (error) console.error('audit log insert failed:', error)
}

interface DashboardRow {
  id: string
  title: string
}

async function getDashboard(
  admin: SupabaseClient,
  dashboardId: string,
): Promise<DashboardRow | null> {
  const { data } = await admin
    .from('dashboards')
    .select('id, title')
    .eq('id', dashboardId)
    .maybeSingle<DashboardRow>()
  return data ?? null
}

/** Whether `userId` has an assignment row on `dashboardId` right now —
 * checked fresh against the table on every call, never trusted from the
 * request or cached, since this is the actual authorization boundary for
 * every Admin action below. */
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

interface TargetProfile {
  id: string
  email: string
  role: CallerRole
}

async function getProfile(
  admin: SupabaseClient,
  userId: string,
): Promise<TargetProfile | null> {
  const { data } = await admin
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .maybeSingle<TargetProfile>()
  return data ?? null
}

async function listAssignments(
  admin: SupabaseClient,
  payload: ListPayload,
  callerId: string,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { dashboardId } = payload ?? ({} as ListPayload)
  if (!dashboardId)
    return json({ error: 'dashboardId is required.' }, 400, cors)

  const dashboard = await getDashboard(admin, dashboardId)
  if (!dashboard) return json({ error: 'Dashboard not found.' }, 404, cors)

  if (
    callerRole === 'admin' &&
    !(await isAssigned(admin, dashboardId, callerId))
  ) {
    return json(
      {
        error: 'You can only view assignments for dashboards assigned to you.',
      },
      403,
      cors,
    )
  }

  const { data, error } = await admin
    .from('dashboard_assignments')
    .select(
      'id, user_id, assigned_at, assigned_by, profiles!dashboard_assignments_user_id_fkey(email, name, role)',
    )
    .eq('dashboard_id', dashboardId)
    .order('assigned_at', { ascending: true })

  if (error) return json({ error: error.message }, 400, cors)

  const assignments = (data ?? []).map((row) => {
    const profile = row.profiles as unknown as {
      email: string
      name: string | null
      role: CallerRole
    } | null
    return {
      id: row.id,
      userId: row.user_id,
      email: profile?.email ?? null,
      name: profile?.name ?? null,
      role: profile?.role ?? null,
      assignedAt: row.assigned_at,
      assignedBy: row.assigned_by,
    }
  })

  return json({ dashboard, assignments }, 200, cors)
}

async function assignDashboard(
  admin: SupabaseClient,
  payload: AssignPayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const { dashboardId, userId } = payload ?? ({} as AssignPayload)
  if (!dashboardId || !userId) {
    return json({ error: 'dashboardId and userId are required.' }, 400, cors)
  }

  const dashboard = await getDashboard(admin, dashboardId)
  if (!dashboard) return json({ error: 'Dashboard not found.' }, 404, cors)

  const target = await getProfile(admin, userId)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  if (callerRole === 'admin') {
    // "verify dashboard is assigned to caller" / "reject modifying
    // dashboards not assigned to caller"
    if (!(await isAssigned(admin, dashboardId, callerId))) {
      return json(
        {
          error:
            'You can only manage assignments for dashboards assigned to you.',
        },
        403,
        cors,
      )
    }
    // "verify every target user has role = Viewer" / "reject assigning
    // Admin or Super Admin"
    if (target.role !== 'viewer') {
      return json(
        { error: 'You can only assign this dashboard to a Viewer.' },
        403,
        cors,
      )
    }
  }
  // super_admin: "allow any assignment" — no further checks.

  // Idempotent: re-assigning someone who already has access is a no-op
  // success, not an error — matches this app's established pattern for
  // "the state you asked for already holds" (e.g. deleteUser).
  const { error } = await admin
    .from('dashboard_assignments')
    .upsert(
      { dashboard_id: dashboardId, user_id: userId, assigned_by: callerId },
      { onConflict: 'dashboard_id,user_id', ignoreDuplicates: true },
    )
  if (error) return json({ error: error.message }, 400, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'dashboard.assignment_added',
    targetType: 'dashboard',
    targetId: dashboardId,
    targetEmail: target.email,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      dashboardTitle: dashboard.title,
      targetUserId: userId,
      targetRole: target.role,
      callerRole,
    },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

async function unassignDashboard(
  admin: SupabaseClient,
  payload: UnassignPayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const { dashboardId, userId } = payload ?? ({} as UnassignPayload)
  if (!dashboardId || !userId) {
    return json({ error: 'dashboardId and userId are required.' }, 400, cors)
  }

  const dashboard = await getDashboard(admin, dashboardId)
  if (!dashboard) return json({ error: 'Dashboard not found.' }, 404, cors)

  const target = await getProfile(admin, userId)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  if (callerRole === 'admin') {
    if (!(await isAssigned(admin, dashboardId, callerId))) {
      return json(
        {
          error:
            'You can only manage assignments for dashboards assigned to you.',
        },
        403,
        cors,
      )
    }
    // "reject removing the caller's own assignment" — checked regardless
    // of the target's role, since this rule is about the ACTOR, not the
    // target's role.
    if (userId === callerId) {
      return json(
        { error: 'You cannot remove your own assignment from a dashboard.' },
        403,
        cors,
      )
    }
    if (target.role !== 'viewer') {
      return json(
        { error: 'You can only remove a Viewer from this dashboard.' },
        403,
        cors,
      )
    }
  }
  // super_admin: "remove any assignment" — no further checks, including
  // removing their own row if they choose to.

  const { data: existing } = await admin
    .from('dashboard_assignments')
    .select('id')
    .eq('dashboard_id', dashboardId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!existing) {
    // Already not assigned — the caller's intent is already satisfied.
    return json({ ok: true, alreadyUnassigned: true }, 200, cors)
  }

  const { error } = await admin
    .from('dashboard_assignments')
    .delete()
    .eq('id', existing.id)
  if (error) return json({ error: error.message }, 400, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'dashboard.assignment_removed',
    targetType: 'dashboard',
    targetId: dashboardId,
    targetEmail: target.email,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      dashboardTitle: dashboard.title,
      targetUserId: userId,
      targetRole: target.role,
      callerRole,
    },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}
