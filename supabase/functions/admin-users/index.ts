// Admin User Management — server-side only.
//
// Uses the service_role key that Supabase automatically injects into every
// Edge Function's runtime (SUPABASE_SERVICE_ROLE_KEY) to perform privileged
// auth.admin.* operations. The frontend never sees service_role — it only
// ever calls this function with its own user session.
//
// Every request must carry the caller's Supabase session (Authorization
// header). The caller's identity + profiles.role are verified before any
// action runs; non-admins get 403.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

const STRONG_PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!STRONG_PASSWORD_RE.test(password)) {
    return 'Password must include an uppercase letter, a lowercase letter, and a number.'
  }
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401)
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
    return json({ error: 'Invalid session' }, 401)
  }

  const { data: callerProfile, error: callerProfileError } = await callerClient
    .from('profiles')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle()

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return json({ error: 'Forbidden: admin role required' }, 403)
  }

  // Service-role client — only reached after the admin check above.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  let body: ActionBody
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  try {
    switch (body.action) {
      case 'list':
        return await listUsers(admin)
      case 'create':
        return await createUser(admin, body.payload)
      case 'update':
        return await updateUser(admin, body.payload)
      case 'setDisabled':
        return await setDisabled(admin, body.payload, caller.id)
      case 'delete':
        return await deleteUser(admin, body.payload, caller.id)
      default:
        return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    console.error('admin-users error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500)
  }
})

// deno-lint-ignore no-explicit-any
async function listUsers(admin: ReturnType<typeof createClient>) {
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

  return json({ users })
}

async function createUser(
  admin: ReturnType<typeof createClient>,
  payload: CreateUserPayload,
) {
  const { email, password, firstName, lastName, role } = payload

  if (!email || !email.includes('@')) {
    return json({ error: 'A valid email is required.' }, 400)
  }
  const passwordError = validatePassword(password ?? '')
  if (passwordError) {
    return json({ error: passwordError }, 400)
  }
  if (role !== 'admin' && role !== 'viewer') {
    return json({ error: 'Role must be admin or viewer.' }, 400)
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
    return json({ error: message }, 400)
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
    return json(
      {
        error: `Couldn't finish creating the profile: ${profileError.message}`,
      },
      500,
    )
  }

  return json({ id: newUserId })
}

async function updateUser(
  admin: ReturnType<typeof createClient>,
  payload: UpdateUserPayload,
) {
  const { userId, name, email, role } = payload
  if (!userId) return json({ error: 'userId is required.' }, 400)

  if (email) {
    const { error: emailError } = await admin.auth.admin.updateUserById(
      userId,
      {
        email,
        email_confirm: true,
      },
    )
    if (emailError) return json({ error: emailError.message }, 400)
  }

  const profileUpdate: Record<string, unknown> = {}
  if (name !== undefined) profileUpdate.name = name
  if (email !== undefined) profileUpdate.email = email
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'viewer') {
      return json({ error: 'Role must be admin or viewer.' }, 400)
    }
    profileUpdate.role = role
  }

  if (Object.keys(profileUpdate).length > 0) {
    const { error: profileError } = await admin
      .from('profiles')
      .update(profileUpdate)
      .eq('id', userId)
    if (profileError) return json({ error: profileError.message }, 400)
  }

  return json({ ok: true })
}

async function setDisabled(
  admin: ReturnType<typeof createClient>,
  payload: SetDisabledPayload,
  callerId: string,
) {
  const { userId, disabled } = payload
  if (!userId) return json({ error: 'userId is required.' }, 400)
  if (userId === callerId && disabled) {
    return json({ error: "You can't disable your own account." }, 400)
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    // ~100 years — effectively permanent until explicitly re-enabled.
    ban_duration: disabled ? '876000h' : 'none',
  })
  if (error) return json({ error: error.message }, 400)

  return json({ ok: true })
}

async function deleteUser(
  admin: ReturnType<typeof createClient>,
  payload: DeleteUserPayload,
  callerId: string,
) {
  const { userId } = payload
  if (!userId) return json({ error: 'userId is required.' }, 400)
  if (userId === callerId) {
    return json({ error: "You can't delete your own account." }, 400)
  }

  // profiles.id -> auth.users(id) on delete cascade removes the profile row;
  // dashboards.created_by / dashboard_status.updated_by are on delete set null,
  // so dashboards and candidate status history are preserved.
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) return json({ error: error.message }, 400)

  return json({ ok: true })
}
