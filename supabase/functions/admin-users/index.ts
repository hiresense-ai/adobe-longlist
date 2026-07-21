// Admin User Management — server-side only.
//
// Uses the service_role key that Supabase automatically injects into every
// Edge Function's runtime (SUPABASE_SERVICE_ROLE_KEY) to perform privileged
// auth.admin.* operations. The frontend never sees service_role — it only
// ever calls this function with its own user session.
//
// Every request must carry the caller's Supabase session (Authorization
// header). The caller's identity + profiles.role are verified before any
// action runs; non-admins get 403. Every mutating action is rate-limited and
// written to audit_logs (both keyed off the verified caller, never anything
// the client asserts about itself).

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Defense-in-depth only — the real gate is the JWT + admin-role check below,
// which applies regardless of the calling origin. Kept as a small exact
// allowlist (plus Vercel preview deployments of this project) rather than
// '*' so a browser won't even attempt the request from an unrelated site.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://adobe-longlist.vercel.app',
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

// 12+ chars, at least one lowercase, one uppercase, one digit, one special char.
const STRONG_PASSWORD_RE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NAME_LENGTH = 100
const MAX_BODY_BYTES = 10_000
const RATE_LIMIT_WINDOW_MINUTES = 10
const RATE_LIMIT_MAX_ACTIONS = 30

function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters.'
  }
  if (!STRONG_PASSWORD_RE.test(password)) {
    return 'Password must include an uppercase letter, a lowercase letter, a number, and a special character.'
  }
  return null
}

function validateName(label: string, value: string): string | null {
  if (!value || !value.trim()) return `${label} is required.`
  if (value.length > MAX_NAME_LENGTH) return `${label} is too long.`
  return null
}

type Role = 'admin' | 'viewer'

interface CreateUserPayload {
  email: string
  password: string
  firstName: string
  lastName: string
  role: Role
}

interface UpdateUserPayload {
  userId: string
  name?: string
  email?: string
  role?: Role
}

interface SetDisabledPayload {
  userId: string
  disabled: boolean
}

interface DeleteUserPayload {
  userId: string
}

type ActionBody =
  | { action: 'list' }
  | { action: 'create'; payload: CreateUserPayload }
  | { action: 'update'; payload: UpdateUserPayload }
  | { action: 'setDisabled'; payload: SetDisabledPayload }
  | { action: 'delete'; payload: DeleteUserPayload }

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

  // Scoped to the caller's own JWT — used only to verify who they are.
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

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return json({ error: 'Forbidden: admin role required' }, 403, cors)
  }

  // Service-role client — only reached after the admin check above.
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

  // `list` is read-only and not rate-limited; every mutating action is.
  if (body.action !== 'list') {
    const limited = await isRateLimited(admin, caller.id)
    if (limited) {
      return json(
        {
          error:
            'Too many admin actions. Please wait a few minutes and try again.',
        },
        429,
        cors,
      )
    }
  }

  try {
    switch (body.action) {
      case 'list':
        return await listUsers(admin, cors)
      case 'create':
        return await createUser(admin, body.payload, caller.id, cors)
      case 'update':
        return await updateUser(admin, body.payload, caller.id, cors)
      case 'setDisabled':
        return await setDisabled(admin, body.payload, caller.id, cors)
      case 'delete':
        return await deleteUser(admin, body.payload, caller.id, cors)
      default:
        return json({ error: 'Unknown action' }, 400, cors)
    }
  } catch (err) {
    console.error('admin-users error:', err)
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
    .like('action', 'user.%')
    .gte('created_at', since)

  if (error) {
    // Fail open on a logging-table hiccup rather than blocking legitimate admin work.
    console.error('rate limit check failed:', error)
    return false
  }

  return (count ?? 0) >= RATE_LIMIT_MAX_ACTIONS
}

async function logAudit(
  admin: SupabaseClient,
  entry: {
    actorId: string
    actorEmail?: string | null
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
    actor_email: entry.actorEmail ?? null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    target_email: entry.targetEmail ?? null,
    metadata: entry.metadata ?? {},
    success: entry.success,
  })
  if (error) console.error('audit log insert failed:', error)
}

async function listUsers(admin: SupabaseClient, cors: Record<string, string>) {
  const [
    { data: authList, error: authError },
    { data: profiles, error: profilesError },
  ] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    admin.from('profiles').select('*'),
  ])

  if (authError) throw authError
  if (profilesError) throw profilesError

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]))

  const users = authList.users.map((u) => {
    const profile = profileById.get(u.id)
    return {
      id: u.id,
      email: u.email ?? '',
      name:
        profile?.name ?? (u.user_metadata?.name as string | undefined) ?? null,
      role: profile?.role ?? 'viewer',
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
      disabled: Boolean(
        u.banned_until && new Date(u.banned_until) > new Date(),
      ),
      emailConfirmed: Boolean(u.email_confirmed_at),
    }
  })

  return json({ users }, 200, cors)
}

async function createUser(
  admin: SupabaseClient,
  payload: CreateUserPayload,
  callerId: string,
  cors: Record<string, string>,
) {
  const { email, password, firstName, lastName, role } =
    payload ?? ({} as CreateUserPayload)

  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: 'A valid email is required.' }, 400, cors)
  }
  const firstNameError = validateName('First name', firstName)
  if (firstNameError) return json({ error: firstNameError }, 400, cors)
  const lastNameError = validateName('Last name', lastName)
  if (lastNameError) return json({ error: lastNameError }, 400, cors)
  const passwordError = validatePassword(password ?? '')
  if (passwordError) {
    return json({ error: passwordError }, 400, cors)
  }
  if (role !== 'admin' && role !== 'viewer') {
    return json({ error: 'Role must be admin or viewer.' }, 400, cors)
  }

  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || null

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    })

  if (createError) {
    const message = createError.message.toLowerCase().includes('already')
      ? 'A user with this email already exists.'
      : createError.message
    await logAudit(admin, {
      actorId: callerId,
      action: 'user.create',
      targetEmail: email,
      metadata: { error: message },
      success: false,
    })
    return json({ error: message }, 400, cors)
  }

  const newUserId = created.user.id

  // handle_new_user() trigger already created a default 'viewer' profile row.
  // Patch in the name/role actually requested.
  const { error: profileError } = await admin
    .from('profiles')
    .update({ name, role })
    .eq('id', newUserId)

  if (profileError) {
    // Roll back the auth user so we never leave an orphaned account behind.
    await admin.auth.admin.deleteUser(newUserId)
    await logAudit(admin, {
      actorId: callerId,
      action: 'user.create',
      targetId: newUserId,
      targetEmail: email,
      metadata: { error: profileError.message },
      success: false,
    })
    return json(
      {
        error: `Couldn't finish creating the profile: ${profileError.message}`,
      },
      500,
      cors,
    )
  }

  await logAudit(admin, {
    actorId: callerId,
    action: 'user.create',
    targetType: 'user',
    targetId: newUserId,
    targetEmail: email,
    metadata: { role },
    success: true,
  })

  return json({ id: newUserId }, 200, cors)
}

async function updateUser(
  admin: SupabaseClient,
  payload: UpdateUserPayload,
  callerId: string,
  cors: Record<string, string>,
) {
  const { userId, name, email, role } = payload ?? ({} as UpdateUserPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)

  if (name !== undefined) {
    const nameError = validateName('Name', name)
    if (nameError) return json({ error: nameError }, 400, cors)
  }
  if (email !== undefined && !EMAIL_RE.test(email)) {
    return json({ error: 'A valid email is required.' }, 400, cors)
  }
  if (role !== undefined && role !== 'admin' && role !== 'viewer') {
    return json({ error: 'Role must be admin or viewer.' }, 400, cors)
  }

  if (email) {
    const { error: emailError } = await admin.auth.admin.updateUserById(
      userId,
      {
        email,
        email_confirm: true,
      },
    )
    if (emailError) {
      const status = isNotFoundError(emailError.message) ? 404 : 400
      return json({ error: emailError.message }, status, cors)
    }
  }

  const profileUpdate: Record<string, unknown> = {}
  if (name !== undefined) profileUpdate.name = name
  if (email !== undefined) profileUpdate.email = email
  if (role !== undefined) profileUpdate.role = role

  if (Object.keys(profileUpdate).length > 0) {
    const { error: profileError } = await admin
      .from('profiles')
      .update(profileUpdate)
      .eq('id', userId)
    if (profileError) return json({ error: profileError.message }, 400, cors)
  }

  await logAudit(admin, {
    actorId: callerId,
    action: role !== undefined ? 'user.role_change' : 'user.update',
    targetType: 'user',
    targetId: userId,
    targetEmail: email,
    metadata: { name, email, role },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

async function setDisabled(
  admin: SupabaseClient,
  payload: SetDisabledPayload,
  callerId: string,
  cors: Record<string, string>,
) {
  const { userId, disabled } = payload ?? ({} as SetDisabledPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)
  if (userId === callerId && disabled) {
    return json({ error: "You can't disable your own account." }, 400, cors)
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    // ~100 years — effectively permanent until explicitly re-enabled.
    ban_duration: disabled ? '876000h' : 'none',
  })
  if (error) {
    const status = isNotFoundError(error.message) ? 404 : 400
    return json({ error: error.message }, status, cors)
  }

  await logAudit(admin, {
    actorId: callerId,
    action: disabled ? 'user.disable' : 'user.enable',
    targetType: 'user',
    targetId: userId,
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

async function deleteUser(
  admin: SupabaseClient,
  payload: DeleteUserPayload,
  callerId: string,
  cors: Record<string, string>,
) {
  const { userId } = payload ?? ({} as DeleteUserPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)
  if (userId === callerId) {
    return json({ error: "You can't delete your own account." }, 400, cors)
  }

  // profiles.id -> auth.users(id) on delete cascade removes the profile row;
  // dashboards.created_by / dashboard_status.updated_by are on delete set null,
  // so dashboards and candidate status history are preserved.
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) {
    const status = isNotFoundError(error.message) ? 404 : 400
    return json({ error: error.message }, status, cors)
  }

  await logAudit(admin, {
    actorId: callerId,
    action: 'user.delete',
    targetType: 'user',
    targetId: userId,
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

function isNotFoundError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('not found') || lower.includes('no user found')
}
