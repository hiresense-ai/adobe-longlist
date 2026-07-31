// Self-service password change — server-side only.
//
// Every authenticated user (super_admin, admin, viewer alike) can change
// their OWN password here, and only their own: the target is always taken
// from the verified JWT, never from the request body, so there is no
// user-supplied id to tamper with and no role check to get wrong.
//
// Changing your own password requires proving you know the current one.
// That check is a real credential verification (a sign-in attempt against
// GoTrue with the supplied current password), not a client-side assertion —
// so a stolen/borrowed session alone can't be used to take over an account.
//
// This is also the only place force_password_change is cleared: an admin
// reset sets it (see admin-users' resetPassword), and it stays set until the
// account holder actually picks their own password here.
//
// Deliberately NOT email-based: this portal has no reset links, no OTP, and
// no outbound mail at all. An administrator hands over a temporary password
// out of band; the user then lands here.

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

// Same rule as admin-users and the frontend's STRONG_PASSWORD_PATTERN.
const STRONG_PASSWORD_RE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/
const MAX_BODY_BYTES = 10_000
const RATE_LIMIT_WINDOW_MINUTES = 15
const RATE_LIMIT_MAX_ATTEMPTS = 10

function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters.'
  }
  if (!STRONG_PASSWORD_RE.test(password)) {
    return 'Password must include an uppercase letter, a lowercase letter, a number, and a special character.'
  }
  return null
}

type SupabaseClient = ReturnType<typeof createClient>

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
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

  // Identify the caller from their own JWT — this is the ONLY source of the
  // account being changed.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser()

  if (callerError || !caller?.email) {
    return json({ error: 'Invalid session' }, 401, cors)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body too large' }, 413, cors)
  }

  let body: { currentPassword?: string; newPassword?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors)
  }

  const currentPassword = body.currentPassword ?? ''
  const newPassword = body.newPassword ?? ''

  // Throttle current-password guessing against a live session.
  if (await isRateLimited(admin, caller.id)) {
    return json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      429,
      cors,
    )
  }

  const passwordError = validatePassword(newPassword)
  if (passwordError) return json({ error: passwordError }, 400, cors)

  if (newPassword === currentPassword) {
    return json(
      { error: 'Your new password must be different from your current one.' },
      400,
      cors,
    )
  }

  // Verify the CURRENT password for real. A fresh anon client is used so this
  // sign-in attempt never disturbs the caller's existing session.
  const verifyClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  })
  const { error: verifyError } = await verifyClient.auth.signInWithPassword({
    email: caller.email,
    password: currentPassword,
  })

  if (verifyError) {
    await logAudit(admin, {
      actorId: caller.id,
      actorEmail: caller.email,
      action: 'user.password_change',
      targetId: caller.id,
      targetEmail: caller.email,
      metadata: { ip, userAgent, reason: 'incorrect current password' },
      success: false,
    })
    return json({ error: 'Your current password is incorrect.' }, 400, cors)
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    caller.id,
    { password: newPassword },
  )
  if (updateError) {
    await logAudit(admin, {
      actorId: caller.id,
      actorEmail: caller.email,
      action: 'user.password_change',
      targetId: caller.id,
      targetEmail: caller.email,
      metadata: { ip, userAgent, error: updateError.message },
      success: false,
    })
    return json({ error: updateError.message }, 400, cors)
  }

  // The user has now chosen their own password, so an admin-imposed
  // temporary one is no longer in force. Verified by reading the row back,
  // not assumed from an error-free response — Postgres can accept an UPDATE
  // and still leave the value unchanged (e.g. a trigger silently reverting
  // it, or a stale read winning a race), and "the password changed but the
  // account stays gated forever" is exactly the failure mode that must not
  // happen silently. One retry covers a transient hiccup; if it still
  // hasn't taken, this is a genuine anomaly worth surfacing rather than
  // returning ok:true over it.
  let flagCleared = false
  for (let attempt = 0; attempt < 2 && !flagCleared; attempt++) {
    const { data: updated, error: updateFlagError } = await admin
      .from('profiles')
      .update({ force_password_change: false })
      .eq('id', caller.id)
      .select('force_password_change')
      .maybeSingle()
    if (updateFlagError) {
      console.error(
        `failed clearing force_password_change (attempt ${attempt + 1}):`,
        updateFlagError,
      )
      continue
    }
    flagCleared = updated?.force_password_change === false
  }

  if (!flagCleared) {
    await logAudit(admin, {
      actorId: caller.id,
      actorEmail: caller.email,
      action: 'user.password_change',
      targetId: caller.id,
      targetEmail: caller.email,
      metadata: { ip, userAgent, self: true, flagCleared: false },
      success: false,
    })
    // The password itself already changed in auth.users — that is not
    // rolled back, since the new password is what the user now actually
    // knows. What failed is only the account-state update, so this is
    // reported as its own distinct problem rather than a generic failure,
    // and specifically NOT as ok:true — the caller must not walk away
    // thinking they're through the gate when the database still says
    // otherwise.
    return json(
      {
        error:
          'Your password was changed, but your account could not be fully updated. Please contact your administrator.',
      },
      500,
      cors,
    )
  }

  // Changing a password revokes EVERY refresh token GoTrue holds for this
  // user — including the session that just made this request. Without a
  // replacement the caller looks signed in only until its access token is
  // next refreshed or the page is reloaded, at which point it is silently
  // logged out with no idea why. (Reproduced: after the update, the old
  // access token returned 403 and its refresh token "Refresh Token Not
  // Found".) Revoking other sessions is correct and worth keeping — a
  // password change should end sessions elsewhere — so the fix is to hand
  // this client a fresh session rather than to weaken the revocation.
  //
  // Signed in with the NEW password, after the update, so these tokens are
  // minted post-revocation and survive.
  const sessionClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: fresh, error: freshError } =
    await sessionClient.auth.signInWithPassword({
      email: caller.email,
      password: newPassword,
    })

  await logAudit(admin, {
    actorId: caller.id,
    actorEmail: caller.email,
    action: 'user.password_change',
    targetType: 'user',
    targetId: caller.id,
    targetEmail: caller.email,
    metadata: {
      ip,
      userAgent,
      self: true,
      flagCleared: true,
      reissuedSession: !freshError,
    },
    success: true,
  })

  // The password change itself already succeeded, so this is still a 200
  // whatever happens here. Without tokens the client signs out cleanly and
  // asks the user to log in again — an explicit, explained re-login rather
  // than a mysterious drop-out later.
  if (freshError || !fresh?.session) {
    console.error('could not reissue session after change:', freshError)
    return json({ ok: true, sessionReissued: false }, 200, cors)
  }

  return json(
    {
      ok: true,
      sessionReissued: true,
      access_token: fresh.session.access_token,
      refresh_token: fresh.session.refresh_token,
    },
    200,
    cors,
  )
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
    .eq('action', 'user.password_change')
    .gte('created_at', since)

  if (error) {
    console.error('rate limit check failed:', error)
    return false
  }
  return (count ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS
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
