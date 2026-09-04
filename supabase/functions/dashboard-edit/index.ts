// Dashboard metadata editing — server-side only.
//
// Mirrors dashboard-assignments' shape (caller identity + role verified from
// a real session before anything runs; service-role client only reached
// after that; every mutation audit-logged) because the same reasoning
// applies: this is the one place service-role writes to the `dashboards`
// table's editable metadata happen, so it's the one place that must get the
// authorization right — a hidden Edit button or a hidden thumbnail control
// is not the boundary.
//
// Rules:
//   super_admin — may edit any dashboard's title, description, category,
//                 AND thumbnail (thumbnail here is just the storage PATH
//                 string or null; the actual Storage upload/delete happens
//                 client-side, same as the existing upload flow, since
//                 super_admin already has direct RLS-permitted access to
//                 the `dashboards` storage bucket).
//   admin       — may edit ANY dashboard (2026-09-04: editing follows
//                 dashboard visibility, and Admins see every dashboard —
//                 no assignment gate), but only title, description, and
//                 category — a request that includes a `thumbnail` key AT
//                 ALL is rejected outright, even if the value would be a
//                 no-op, so a hand-crafted request can never slip a
//                 thumbnail change through.
//   viewer      — 403 on every action here. No edit permissions at all.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Same allowlist as admin-users/dashboard-assignments — defense-in-depth
// only, the real gate is the JWT + role check below regardless of origin.
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
const MAX_TEXT_FIELD_LENGTH = 5_000

type CallerRole = 'super_admin' | 'admin' | 'viewer'

interface UpdatePayload {
  dashboardId: string
  title?: string
  description?: string | null
  category?: string | null
  thumbnail?: string | null
}

type ActionBody = { action: 'update'; payload: UpdatePayload }

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

  // Viewer has zero dashboard-edit permissions.
  if (callerRole === 'viewer') {
    return json({ error: 'Viewers cannot edit dashboards.' }, 403, cors)
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
      case 'update':
        return await updateDashboard(
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
    console.error('dashboard-edit error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500, cors)
  }
})

async function logAudit(
  admin: SupabaseClient,
  entry: {
    actorId: string
    action: string
    targetType?: string
    targetId?: string
    metadata?: Record<string, unknown>
    success: boolean
  },
) {
  const { error } = await admin.from('audit_logs').insert({
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    success: entry.success,
  })
  if (error) console.error('audit log insert failed:', error)
}

interface DashboardRow {
  id: string
  title: string
  description: string | null
  category: string | null
  thumbnail: string | null
}

async function getDashboard(
  admin: SupabaseClient,
  dashboardId: string,
): Promise<DashboardRow | null> {
  const { data } = await admin
    .from('dashboards')
    .select('id, title, description, category, thumbnail')
    .eq('id', dashboardId)
    .maybeSingle<DashboardRow>()
  return data ?? null
}

// (The per-call isAssigned() helper was removed 2026-09-04: Admin edits now
// follow dashboard visibility — every dashboard — so no assignment check
// remains in this function. Viewers are rejected outright above.)

async function updateDashboard(
  admin: SupabaseClient,
  payload: UpdatePayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const { dashboardId } = payload ?? ({} as UpdatePayload)
  if (!dashboardId) {
    return json({ error: 'dashboardId is required.' }, 400, cors)
  }

  const dashboard = await getDashboard(admin, dashboardId)
  if (!dashboard) return json({ error: 'Dashboard not found.' }, 404, cors)

  if (callerRole === 'admin') {
    // 2026-09-04: no assignment gate anymore — an Admin may edit ANY
    // dashboard's text fields, matching their dashboard visibility.
    // Viewer callers are still rejected at the top of the handler, and
    // the thumbnail stays Super-Admin-only below.
    // Hard reject — even a no-op thumbnail key in the request body is
    // treated as an unauthorized attempt, never silently dropped.
    if (Object.prototype.hasOwnProperty.call(payload, 'thumbnail')) {
      return json(
        { error: 'Admins cannot modify the dashboard thumbnail.' },
        403,
        cors,
      )
    }
  }
  // super_admin: title, description, category, and thumbnail all allowed —
  // no assignment check, matches existing dashboards_*_super_admin RLS.

  const updates: Record<string, string | null> = {}

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    if (!title) {
      return json({ error: 'Dashboard name is required.' }, 400, cors)
    }
    if (title.length > MAX_TEXT_FIELD_LENGTH) {
      return json({ error: 'Dashboard name is too long.' }, 400, cors)
    }
    updates.title = title
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    const description =
      typeof payload.description === 'string' ? payload.description.trim() : ''
    if (description.length > MAX_TEXT_FIELD_LENGTH) {
      return json({ error: 'Description is too long.' }, 400, cors)
    }
    updates.description = description || null
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'category')) {
    const category =
      typeof payload.category === 'string' ? payload.category.trim() : ''
    if (category.length > MAX_TEXT_FIELD_LENGTH) {
      return json({ error: 'Category is too long.' }, 400, cors)
    }
    updates.category = category || null
  }

  // Only reachable for super_admin — admin requests with a thumbnail key
  // were already rejected above.
  if (Object.prototype.hasOwnProperty.call(payload, 'thumbnail')) {
    updates.thumbnail =
      typeof payload.thumbnail === 'string' ? payload.thumbnail : null
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No editable fields were provided.' }, 400, cors)
  }

  const { data: updated, error } = await admin
    .from('dashboards')
    .update(updates)
    .eq('id', dashboardId)
    .select()
    .single()

  if (error) return json({ error: error.message }, 400, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'dashboard.edited',
    targetType: 'dashboard',
    targetId: dashboardId,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      dashboardTitle: dashboard.title,
      callerRole,
      fields: Object.keys(updates),
    },
    success: true,
  })

  return json({ dashboard: updated }, 200, cors)
}
