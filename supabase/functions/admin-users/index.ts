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
//
// Role hierarchy (super_admin > admin > viewer) — enforced here, not just in
// the UI, since this is the only place service-role writes actually happen:
//   - list:     super_admin sees everyone. admin never sees a super_admin
//     row at all — filtered out of the response itself (see listUsers), so
//     it can't leak into search, filters, or pagination counts either,
//     since all of those run client-side over this same array.
//   - create:   super_admin -> admin | viewer.  admin -> viewer only.
//   - unlock:   super_admin -> admin | viewer.  admin -> viewer only.
//   - resetPassword: super_admin -> super_admin | admin | viewer (the one
//     action allowed against a super_admin target, including the caller's
//     own account). admin -> viewer only.
//   - super_admin accounts can't be created, disabled, deleted, or demoted
//     through this endpoint — that role is assigned by hand outside the
//     application (see the account-security migration), so its lifecycle
//     stays outside the app's own reach. Password reset is the deliberate
//     exception: this portal has no email reset flow, so without it a
//     locked-out super_admin would have no in-app recovery path at all.
//   - an admin cannot disable, delete, or reset the password of another
//     admin — only super_admin can.
//   - every reset of SOMEONE ELSE's password sets profiles
//     .force_password_change, which the app enforces on next login and only
//     the change-password function can clear.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { isLockExpired } from '../_shared/lockout.ts'

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

// The role a NEW or UPDATED user can be assigned through this API.
// 'super_admin' is deliberately excluded — see the module comment.
type AssignableRole = 'admin' | 'viewer'
// The caller's own role, which can be any of the three.
type CallerRole = 'super_admin' | 'admin' | 'viewer'

interface CreateUserPayload {
  email: string
  password: string
  firstName: string
  lastName: string
  role: AssignableRole
}

interface UpdateUserPayload {
  userId: string
  name?: string
  email?: string
  role?: AssignableRole
}

interface SetDisabledPayload {
  userId: string
  disabled: boolean
}

interface DeleteUserPayload {
  userId: string
}

interface UnlockUserPayload {
  userId: string
}

interface ResetPasswordPayload {
  userId: string
  newPassword: string
}

type ActionBody =
  | { action: 'list' }
  | { action: 'create'; payload: CreateUserPayload }
  | { action: 'update'; payload: UpdateUserPayload }
  | { action: 'setDisabled'; payload: SetDisabledPayload }
  | { action: 'delete'; payload: DeleteUserPayload }
  | { action: 'unlock'; payload: UnlockUserPayload }
  | { action: 'resetPassword'; payload: ResetPasswordPayload }

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

  // Recorded on password resets for the audit trail (see resetPassword).
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const userAgent = req.headers.get('user-agent') ?? 'unknown'

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

  const callerRole = callerProfile?.role as CallerRole | undefined

  if (
    callerProfileError ||
    (callerRole !== 'admin' && callerRole !== 'super_admin')
  ) {
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
        return await listUsers(admin, callerRole, cors)
      case 'create':
        return await createUser(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'update':
        return await updateUser(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'setDisabled':
        return await setDisabled(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'delete':
        return await deleteUser(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'unlock':
        return await unlockUser(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'resetPassword':
        return await resetPassword(
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

async function listUsers(
  admin: SupabaseClient,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
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

  // ---------------------------------------------------------------------
  // Deleted-account reconciliation.
  //
  // GoTrue supports SOFT delete, and deleting a user from the Supabase
  // Dashboard can take that path: the auth.users row survives with
  // deleted_at set. Two consequences this list used to get wrong, both
  // reproduced against the live project before this fix:
  //   1. auth.admin.listUsers() still returns the row, so the account went
  //      on being listed in the UI forever — not a cache artifact, the
  //      server really was reporting it, so refreshing never helped.
  //   2. profiles.id references auth.users ON DELETE CASCADE, and the row
  //      is still there, so the cascade never fires and the profile lingers.
  // A soft-deleted account can't sign in, so listing it is simply wrong.
  const isDeleted = (u: { deleted_at?: string | null }) => Boolean(u.deleted_at)
  const liveAuthUsers = authList.users.filter((u) => !isDeleted(u))
  const liveAuthIds = new Set(liveAuthUsers.map((u) => u.id))

  // Orphans (a profile with no live auth user behind it) are HIDDEN, never
  // deleted here.
  //
  // An earlier version of this function deleted them on every list call, and
  // that was a mistake: `list` is a read path that any admin triggers just by
  // opening the Users page, it runs with service_role, and its only input is
  // whatever auth.admin.listUsers() happened to return. If that call is ever
  // incomplete — a clamped page size, a partial response, a transient upstream
  // hiccup — every profile missing from it looks exactly like an orphan, and
  // the sweep deletes live users' roles. That failure is silent, immediate and
  // unrecoverable, whereas the worst case for hiding is a row that stops being
  // listed until someone looks into it. A read must not be able to destroy
  // data, so the destructive branch is gone.
  //
  // Actual deletion still happens, but only where it is explicitly asked for
  // and scoped to ONE id the caller named: see deleteUser, which cleans the
  // orphan for the specific account being deleted.
  const orphanIds = (profiles ?? [])
    .map((p) => p.id as string)
    .filter((id) => !liveAuthIds.has(id))

  if (orphanIds.length > 0) {
    console.log(
      `hiding ${orphanIds.length} orphaned profile(s) from the list;` +
        ' delete the account explicitly to clean them up',
    )
    for (const id of orphanIds) profileById.delete(id)
  }

  // public.profiles IS the application's user registry — auth.users is only
  // the credential store behind it. So an auth row with NO profile row is not
  // a user of this app and is not listed.
  //
  // This is the case behind the reported bug: deleting a row from the
  // profiles table in the Supabase Dashboard removes the CHILD of the
  // profiles -> auth.users foreign key, and a cascade only ever travels
  // parent -> child, so auth.users was left untouched. This list is built by
  // mapping over auth.users, so the account kept appearing, with `role`
  // quietly falling back to 'viewer' for the profile that no longer existed.
  // Deleting it from the UI then failed with "User not found", because
  // deleteUser looked the target up in profiles first.
  //
  // Such an account cannot sign in either — auth-login resolves the caller
  // through profiles — so listing it was showing an account that, from this
  // application's point of view, genuinely no longer exists.
  const registeredAuthUsers = liveAuthUsers.filter((u) => profileById.has(u.id))
  const unregisteredCount = liveAuthUsers.length - registeredAuthUsers.length
  if (unregisteredCount > 0) {
    console.log(
      `hiding ${unregisteredCount} auth user(s) with no profile row;` +
        ' they cannot sign in and are not listed',
    )
  }

  // Super Admin visibility: a Super Admin caller sees everyone; anyone else
  // (a plain admin — the only other role that reaches this function) must
  // never see a Super Admin account here, in search results built on top of
  // this response, in filters, or in pagination counts, since all of those
  // are client-side operations over this same array — excluding the rows
  // here is what makes every one of those surfaces correct at once. This
  // mirrors src/lib/permissions.ts's canViewUser.
  const authUsers =
    callerRole === 'super_admin'
      ? registeredAuthUsers
      : registeredAuthUsers.filter(
          (u) => (profileById.get(u.id)?.role ?? 'viewer') !== 'super_admin',
        )

  const users = authUsers.map((u) => {
    const profile = profileById.get(u.id)
    // A lock whose random timer has already passed reads as unlocked here
    // without anyone having to explicitly unlock it — there's no scheduled
    // sweep (see the lock_expires_at migration comment), so this list is
    // one of the two places (auth-login is the other) that actually applies
    // the expiry. Purely a read-time computation: this never writes to the
    // row, so an account nobody has tried to log into since expiring stays
    // showing "Locked" in the DB until the next read or login attempt
    // re-derives it — that's fine, since nothing here depends on the raw
    // column being eagerly cleared, only on what's displayed being correct.
    const stillLocked =
      Boolean(profile?.locked_at) &&
      !isLockExpired(profile?.lock_expires_at ?? null)
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
      locked: stillLocked,
      lockExpiresAt: stillLocked ? (profile?.lock_expires_at ?? null) : null,
      failedLoginAttempts: profile?.failed_login_attempts ?? 0,
    }
  })

  return json({ users }, 200, cors)
}

async function createUser(
  admin: SupabaseClient,
  payload: CreateUserPayload,
  callerId: string,
  callerRole: CallerRole,
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
  if (role === 'admin' && callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can create Admin accounts.' },
      403,
      cors,
    )
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

  // handle_new_user() trigger already created a default 'viewer' profile row
  // (it now clamps any client-supplied role to admin/viewer regardless, so
  // this update is what actually assigns the role requested here).
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
  callerRole: CallerRole,
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

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  if (targetError) return json({ error: targetError.message }, 400, cors)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  // super_admin's role/lifecycle is managed by hand, outside the app — see
  // the module comment — so it can't be changed (in either direction)
  // through this endpoint at all.
  if (target.role === 'super_admin') {
    return json(
      { error: "Super Admin accounts can't be modified here." },
      403,
      cors,
    )
  }
  // Changing a role TO admin, or changing one AWAY FROM admin (a demotion of
  // a peer, not "managing a viewer"), both require a Super Admin — a regular
  // Admin can only ever touch a Viewer's role.
  if (
    role !== undefined &&
    role !== target.role &&
    (role === 'admin' || target.role === 'admin') &&
    callerRole !== 'super_admin'
  ) {
    return json(
      { error: "Only a Super Admin can change an Admin's role." },
      403,
      cors,
    )
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
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { userId, disabled } = payload ?? ({} as SetDisabledPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)
  if (userId === callerId && disabled) {
    return json({ error: "You can't disable your own account." }, 400, cors)
  }

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  if (targetError) return json({ error: targetError.message }, 400, cors)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  if (target.role === 'super_admin') {
    return json({ error: "Super Admin accounts can't be disabled." }, 403, cors)
  }
  if (target.role === 'admin' && callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can disable an Admin account.' },
      403,
      cors,
    )
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
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { userId } = payload ?? ({} as DeleteUserPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)
  if (userId === callerId) {
    return json({ error: "You can't delete your own account." }, 400, cors)
  }

  // Both sides are read before deciding, because they can legitimately
  // disagree: a soft delete leaves auth.users present-but-deleted with the
  // profile intact, and a hard delete elsewhere removes both while a stale
  // browser tab still offers the button.
  const [
    { data: target, error: targetError },
    { data: authUser, error: authLookupError },
  ] = await Promise.all([
    admin.from('profiles').select('role, email').eq('id', userId).maybeSingle(),
    admin.auth.admin.getUserById(userId),
  ])
  if (targetError) return json({ error: targetError.message }, 400, cors)

  // getUserById 404s for an id that is fully gone — that's an expected
  // state here, not a failure, so only a real error is surfaced.
  const authMissing =
    Boolean(authLookupError) && isNotFoundError(authLookupError!.message)
  if (authLookupError && !authMissing) {
    return json({ error: authLookupError.message }, 400, cors)
  }
  const liveAuthUser =
    !authMissing && authUser?.user && !authUser.user.deleted_at
      ? authUser.user
      : null

  // Already gone on both sides: converge instead of erroring. This is the
  // exact case that used to surface "User not found." — an admin clicking
  // Delete on a row that a Dashboard delete had already removed. The
  // caller's intent (this account should not exist) is already satisfied,
  // so report success and let the client refresh.
  if (!target && !liveAuthUser && authMissing) {
    return json({ ok: true, alreadyDeleted: true }, 200, cors)
  }

  // Orphan: a profile with no live auth user behind it (soft delete, or a
  // row that outlived its auth user). Clean it up and report success rather
  // than making the operator chase a phantom account.
  if (target && !liveAuthUser) {
    // Still attempt a hard delete first, so a SOFT-deleted auth row is
    // really removed rather than left to keep blocking its own email.
    if (!authMissing) await admin.auth.admin.deleteUser(userId)
    const { error: orphanError } = await admin
      .from('profiles')
      .delete()
      .eq('id', userId)
    if (orphanError) return json({ error: orphanError.message }, 400, cors)

    await logAudit(admin, {
      actorId: callerId,
      action: 'user.delete',
      targetType: 'user',
      targetId: userId,
      targetEmail: target.email,
      metadata: { orphanCleanup: true },
      success: true,
    })
    return json({ ok: true, orphanCleaned: true }, 200, cors)
  }

  // A live auth user with no profile row has no role, and therefore no
  // privileges — role lives entirely in profiles. Treating it as 'viewer'
  // matches how listUsers renders the same case.
  const targetRole = target?.role ?? 'viewer'

  if (targetRole === 'super_admin') {
    return json({ error: "Super Admin accounts can't be deleted." }, 403, cors)
  }
  if (targetRole === 'admin' && callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can delete an Admin account.' },
      403,
      cors,
    )
  }

  // profiles.id -> auth.users(id) on delete cascade removes the profile row;
  // dashboards.created_by / dashboard_status.updated_by are on delete set null,
  // so dashboards and candidate status history are preserved.
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) {
    // Lost a race with another delete — the end state is what was asked for.
    if (isNotFoundError(error.message)) {
      await admin.from('profiles').delete().eq('id', userId)
      return json({ ok: true, alreadyDeleted: true }, 200, cors)
    }
    return json({ error: error.message }, 400, cors)
  }

  // The cascade normally removes the profile with the auth row. Verified
  // afterwards rather than assumed: if anything left it behind, the account
  // would come back as an orphan on the next list, so it is swept here
  // while the audit entry can still name it.
  const { data: leftover } = await admin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle()
  if (leftover) {
    const { error: sweepError } = await admin
      .from('profiles')
      .delete()
      .eq('id', userId)
    if (sweepError) {
      console.error('profile sweep after delete failed:', sweepError)
    }
  }

  await logAudit(admin, {
    actorId: callerId,
    action: 'user.delete',
    targetType: 'user',
    targetId: userId,
    targetEmail: target?.email,
    metadata: { profileSweptManually: Boolean(leftover) },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

async function unlockUser(
  admin: SupabaseClient,
  payload: UnlockUserPayload,
  callerId: string,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { userId } = payload ?? ({} as UnlockUserPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('role, email, locked_at')
    .eq('id', userId)
    .maybeSingle()
  if (targetError) return json({ error: targetError.message }, 400, cors)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  if (target.role === 'super_admin') {
    return json({ error: 'Super Admin accounts are never locked.' }, 400, cors)
  }
  if (target.role === 'admin' && callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can unlock an Admin account.' },
      403,
      cors,
    )
  }
  // target.role === 'viewer' is unlockable by either admin or super_admin —
  // both already passed the top-level "is at least admin" gate.

  if (!target.locked_at) {
    return json({ error: 'This account is not locked.' }, 400, cors)
  }

  const { error } = await admin
    .from('profiles')
    .update({
      locked_at: null,
      lock_expires_at: null,
      failed_login_attempts: 0,
    })
    .eq('id', userId)
  if (error) return json({ error: error.message }, 400, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'account.unlocked',
    targetType: 'user',
    targetId: userId,
    targetEmail: target.email,
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

async function resetPassword(
  admin: SupabaseClient,
  payload: ResetPasswordPayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const { userId, newPassword } = payload ?? ({} as ResetPasswordPayload)
  if (!userId) return json({ error: 'userId is required.' }, 400, cors)
  const passwordError = validatePassword(newPassword ?? '')
  if (passwordError) return json({ error: passwordError }, 400, cors)

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('role, email')
    .eq('id', userId)
    .maybeSingle()
  if (targetError) return json({ error: targetError.message }, 400, cors)
  if (!target) return json({ error: 'User not found.' }, 404, cors)

  // Password reset is the ONE action a Super Admin may perform against
  // another Super Admin (including their own account), deliberately unlike
  // update/disable/delete/unlock, which stay off-limits for every
  // super_admin target. With no email reset flow left in this portal, a
  // locked-out Super Admin would otherwise have no in-app recovery path at
  // all. An Admin still cannot touch an Admin or a Super Admin.
  if (callerRole !== 'super_admin' && target.role !== 'viewer') {
    return json(
      {
        error:
          target.role === 'super_admin'
            ? "Only a Super Admin can reset a Super Admin's password."
            : "Only a Super Admin can reset an Admin's password.",
      },
      403,
      cors,
    )
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (error) {
    const status = isNotFoundError(error.message) ? 404 : 400
    return json({ error: error.message }, status, cors)
  }

  // What the admin just set is a TEMPORARY password they read out to the
  // user, so the account is flagged until its owner picks their own. The
  // app blocks every route while this is true, and only the
  // change-password function (which requires the current password) clears
  // it. Skipped when a Super Admin resets their own account — they have
  // just chosen that password themselves, so there is nothing to force.
  if (userId !== callerId) {
    const { error: flagError } = await admin
      .from('profiles')
      .update({ force_password_change: true })
      .eq('id', userId)
    if (flagError) {
      console.error('failed setting force_password_change:', flagError)
    }
  }

  // Deliberately independent of unlock — see the module comment. Resetting
  // a password never implicitly clears a lock; that's a separate, explicit
  // action with its own audit trail.
  await logAudit(admin, {
    actorId: callerId,
    action: 'user.password_reset',
    targetType: 'user',
    targetId: userId,
    targetEmail: target.email,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      targetRole: target.role,
      forcePasswordChange: userId !== callerId,
      self: userId === callerId,
    },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}

function isNotFoundError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('not found') || lower.includes('no user found')
}
