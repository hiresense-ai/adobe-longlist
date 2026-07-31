// Account-security login gate — server-side only, unauthenticated by design
// (nobody has a session yet at login time).
//
// The frontend no longer calls supabase.auth.signInWithPassword() directly:
// GoTrue has no concept of this app's lockout state, so a direct client-side
// call would completely bypass it — a "locked" account could still sign in
// with the correct password. Every login attempt is routed through here
// instead, which checks the lock state BEFORE attempting authentication,
// and tracks/enforces failed attempts around a real signInWithPassword call
// using the service role. On success it hands back the session tokens for
// the frontend to adopt with supabase.auth.setSession().
//
// Security posture:
// - Never reveals whether an email is registered. A nonexistent email and a
//   wrong password for a real, unlocked account return the identical
//   generic message. The one deliberate exception is once an account is
//   actually locked — per spec, that state IS surfaced with a specific
//   message, since at that point the caller has already demonstrated
//   knowledge of the address by attempting it three times, and telling
//   them to stop is the whole point of a friendly lockout notice.
// - Every attempt is written to audit_logs, including ones against emails
//   that don't exist (actor_id is null there; there is no actor yet).

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  isLockExpired,
  lockedMessage,
  randomLockDurationMs,
  remainingLockMinutes,
} from '../_shared/lockout.ts'

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
    // supabase-js's client attaches apikey/authorization/x-client-info to
    // every request it makes, including functions.invoke() calls to an
    // endpoint like this one that doesn't need or use them — the SDK has
    // no way to know that ahead of time. The browser's CORS preflight
    // check requires every header the client will actually send to appear
    // here, or it blocks the real request client-side before it's ever
    // sent (a bare "Failed to fetch", indistinguishable from a network
    // failure). Matches admin-users' already-correct, already-working
    // allow-list exactly, for the same reason.
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

const MAX_FAILED_ATTEMPTS = 3
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_BODY_BYTES = 2_000

// Generic on purpose — see the module comment. Used for: unknown email,
// wrong password, and malformed input alike.
const GENERIC_ERROR = 'Invalid email or password.'
// Fallback only, for a lock that predates the lock_expires_at column (set by
// an old build, or set directly some other way) and so has no timer to
// report a duration from. Every lock created by this build always has one.
const LOCKED_ERROR_NO_EXPIRY =
  'This account has been locked after multiple failed sign-in attempts. Contact your administrator to unlock it.'
const DISABLED_ERROR =
  'This account has been disabled. Contact your administrator.'

// Defense-in-depth against scripting this endpoint itself, independent of
// the 3-attempt account lock: slows a burst against one address or from one
// client without waiting for the permanent lock to kick in. Mirrors the
// windowed-count pattern already used in admin-users/index.ts.
const IP_RATE_LIMIT_WINDOW_MINUTES = 5
const IP_RATE_LIMIT_MAX_ATTEMPTS = 20

type SupabaseClient = ReturnType<typeof createClient>

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const clientIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body too large' }, 413, cors)
  }

  let body: { email?: unknown; password?: unknown }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: GENERIC_ERROR }, 400, cors)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !EMAIL_RE.test(email) || !password) {
    return json({ error: GENERIC_ERROR }, 400, cors)
  }

  if (await isIpRateLimited(admin, clientIp)) {
    return json(
      {
        error:
          'Too many sign-in attempts. Please wait a few minutes and try again.',
      },
      429,
      cors,
    )
  }

  try {
    return await handleLogin(admin, email, password, clientIp, cors)
  } catch (err) {
    console.error('auth-login error:', err)
    return json({ error: GENERIC_ERROR }, 500, cors)
  }
})

async function isIpRateLimited(
  admin: SupabaseClient,
  ip: string,
): Promise<boolean> {
  if (ip === 'unknown') return false
  const since = new Date(
    Date.now() - IP_RATE_LIMIT_WINDOW_MINUTES * 60_000,
  ).toISOString()
  const { count, error } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'login.failure')
    .gte('created_at', since)
    .contains('metadata', { ip })

  if (error) {
    console.error('login rate limit check failed:', error)
    return false // fail open — a logging hiccup shouldn't lock everyone out
  }
  return (count ?? 0) >= IP_RATE_LIMIT_MAX_ATTEMPTS
}

async function logAudit(
  admin: SupabaseClient,
  entry: {
    actorId?: string | null
    targetId?: string | null
    targetEmail: string
    action: string
    success: boolean
    metadata?: Record<string, unknown>
  },
) {
  const { error } = await admin.from('audit_logs').insert({
    actor_id: entry.actorId ?? null,
    action: entry.action,
    target_type: 'user',
    target_id: entry.targetId ?? null,
    target_email: entry.targetEmail,
    metadata: entry.metadata ?? {},
    success: entry.success,
  })
  if (error) console.error('audit log insert failed:', error)
}

interface ProfileLookup {
  id: string
  email: string
  role: 'super_admin' | 'admin' | 'viewer'
  failed_login_attempts: number
  locked_at: string | null
  lock_expires_at: string | null
}

async function handleLogin(
  admin: SupabaseClient,
  email: string,
  password: string,
  clientIp: string,
  cors: Record<string, string>,
): Promise<Response> {
  const { data: profile } = await admin
    .from('profiles')
    .select(
      'id, email, role, failed_login_attempts, locked_at, lock_expires_at',
    )
    .ilike('email', email)
    .maybeSingle<ProfileLookup>()

  // Unknown email: log it (actor_id null — there is no actor) and return the
  // exact same message a wrong password gets. Do not touch any counters —
  // there is no row to touch, and doing anything email-shaped here (e.g.
  // creating a shadow record) would itself be an oracle.
  if (!profile) {
    await logAudit(admin, {
      targetEmail: email,
      action: 'login.failure',
      success: false,
      metadata: { ip: clientIp, reason: 'no_such_account' },
    })
    return json({ error: GENERIC_ERROR }, 401, cors)
  }

  const isSuperAdmin = profile.role === 'super_admin'

  // Already locked: never even attempt authentication. Locking is an
  // administrative hold, not a rate limit — a correct password must not be
  // able to walk through it, or the lock is theater.
  //
  // Unless the random 10-20 minute timer has actually passed: then this is
  // the moment that's discovered (there's no scheduled sweep — see the
  // migration comment), so it's cleared here and the request falls through
  // to a normal credential check below, exactly as if it had never locked.
  if (profile.locked_at && !isSuperAdmin) {
    if (isLockExpired(profile.lock_expires_at)) {
      await admin
        .from('profiles')
        .update({
          locked_at: null,
          lock_expires_at: null,
          failed_login_attempts: 0,
        })
        .eq('id', profile.id)
      await logAudit(admin, {
        actorId: profile.id,
        targetId: profile.id,
        targetEmail: profile.email,
        action: 'account.unlocked',
        success: true,
        metadata: { ip: clientIp, reason: 'expired' },
      })
      profile.locked_at = null
      profile.lock_expires_at = null
      profile.failed_login_attempts = 0
    } else {
      await logAudit(admin, {
        actorId: profile.id,
        targetId: profile.id,
        targetEmail: profile.email,
        action: 'login.failure',
        success: false,
        metadata: { ip: clientIp, reason: 'locked' },
      })
      return json(
        {
          error: profile.lock_expires_at
            ? lockedMessage(profile.lock_expires_at)
            : LOCKED_ERROR_NO_EXPIRY,
          locked: true,
          remainingMinutes: profile.lock_expires_at
            ? remainingLockMinutes(profile.lock_expires_at)
            : null,
        },
        403,
        cors,
      )
    }
  }

  // Disabled (admin-users' existing ban feature) is a separate concern from
  // lockout and must not feed the failed-attempt counter — an admin
  // deliberately disabling someone shouldn't also (cosmetically) lock them.
  const { data: authUser } = await admin.auth.admin.getUserById(profile.id)
  const isDisabled = Boolean(
    authUser?.user?.banned_until &&
    new Date(authUser.user.banned_until) > new Date(),
  )
  if (isDisabled) {
    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: 'login.failure',
      success: false,
      metadata: { ip: clientIp, reason: 'disabled' },
    })
    return json({ error: DISABLED_ERROR }, 403, cors)
  }

  // The actual credential check. A plain anon-key client, not the service
  // role — this is the one call in the whole function that must genuinely
  // verify the password, so it goes through the real auth flow.
  const attemptClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: signInData, error: signInError } =
    await attemptClient.auth.signInWithPassword({
      email: profile.email,
      password,
    })

  if (!signInError && signInData.session) {
    await admin
      .from('profiles')
      .update({
        failed_login_attempts: 0,
        locked_at: null,
        lock_expires_at: null,
      })
      .eq('id', profile.id)

    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: 'login.success',
      success: true,
      metadata: { ip: clientIp },
    })

    return json(
      {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      },
      200,
      cors,
    )
  }

  // Wrong password from here on. super_admin: log it, count it for
  // visibility, but never lock — enforced by simply never writing
  // locked_at/lock_expires_at in this branch, regardless of the new count.
  const nextAttempts = profile.failed_login_attempts + 1
  const willLock = !isSuperAdmin && nextAttempts >= MAX_FAILED_ATTEMPTS
  // Chosen fresh on every lock, per spec — not a fixed duration.
  const lockExpiresAt = willLock
    ? new Date(Date.now() + randomLockDurationMs()).toISOString()
    : null

  await admin
    .from('profiles')
    .update({
      failed_login_attempts: nextAttempts,
      locked_at: willLock ? new Date().toISOString() : null,
      lock_expires_at: lockExpiresAt,
      last_failed_login_at: new Date().toISOString(),
    })
    .eq('id', profile.id)

  await logAudit(admin, {
    actorId: profile.id,
    targetId: profile.id,
    targetEmail: profile.email,
    action: 'login.failure',
    success: false,
    metadata: { ip: clientIp, attempts: nextAttempts },
  })

  if (willLock && lockExpiresAt) {
    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: 'account.locked',
      success: true,
      metadata: {
        ip: clientIp,
        reason: 'max_failed_attempts',
        lockExpiresAt,
        lockDurationMinutes: remainingLockMinutes(lockExpiresAt),
      },
    })
    return json(
      {
        error: lockedMessage(lockExpiresAt),
        locked: true,
        remainingMinutes: remainingLockMinutes(lockExpiresAt),
      },
      403,
      cors,
    )
  }

  return json({ error: GENERIC_ERROR }, 401, cors)
}
