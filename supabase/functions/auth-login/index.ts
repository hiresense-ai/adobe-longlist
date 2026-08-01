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
import { AUTH_MESSAGES, classifySignInFailure } from '../_shared/authErrors.ts'

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
// wrong password, and malformed input alike. Single-sourced from the shared
// classifier so the message this function returns and the message that
// module's tests assert on can never drift apart.
const GENERIC_ERROR = AUTH_MESSAGES.invalidCredentials
// Fallback only, for a lock that predates the lock_expires_at column (set by
// an old build, or set directly some other way) and so has no timer to
// report a duration from. Every lock created by this build always has one.
const LOCKED_ERROR_NO_EXPIRY =
  'This account has been locked after multiple failed sign-in attempts. Contact your administrator to unlock it.'
const DISABLED_ERROR =
  'This account has been disabled. Contact your administrator.'
// Shared verbatim by both rate-limit sources (our own IP counter below, and
// GoTrue's own upstream limit further down) — same user-facing wording
// either way, since the caller has no reason to know which layer tripped.
const RATE_LIMIT_ERROR = AUTH_MESSAGES.rateLimited
// Used for every non-credential failure (upstream 5xx, network failure,
// anything unrecognized) — must never say "Invalid email or password", since
// that specifically asserts the credentials were checked and found wrong,
// which did not happen in any of those cases.
const UPSTREAM_ERROR = AUTH_MESSAGES.unavailable

// Audit action for authentication attempts that failed for a reason that is
// NOT the caller's credentials — upstream rate limiting, a GoTrue 5xx, a
// network failure. Deliberately distinct from 'login.failure' so these never
// feed isIpRateLimited() below; see the comment there for why that
// separation matters.
const UPSTREAM_ERROR_ACTION = 'login.error'

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
  const userAgent = req.headers.get('user-agent') ?? 'unknown'

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
    logAttempt({
      email,
      supabaseErrorCode: null,
      httpStatus: 429,
      decision: 'rate_limited_ip',
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: false,
    })
    return json({ error: RATE_LIMIT_ERROR }, 429, cors)
  }

  try {
    return await handleLogin(admin, email, password, clientIp, userAgent, cors)
  } catch (err) {
    console.error('auth-login error:', err)
    // A genuine crash (not a signInWithPassword error result — those are
    // handled inside handleLogin without throwing) must not claim the
    // credentials were checked, for the same reason as UPSTREAM_ERROR below.
    logAttempt({
      email,
      supabaseErrorCode: null,
      httpStatus: 500,
      decision: 'unexpected_exception',
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: false,
    })
    return json({ error: UPSTREAM_ERROR }, 500, cors)
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
  // Counts 'login.failure' ONLY — i.e. genuine credential/authorization
  // failures. Non-credential problems (GoTrue rate limiting, an upstream
  // 5xx, a network blip) are deliberately logged under a different action
  // (UPSTREAM_ERROR_ACTION) precisely so they can never land here: otherwise
  // an upstream outage or an already-tripped GoTrue limit would compound
  // into this app blocking the IP as well, punishing users for a failure
  // that was never theirs and that no amount of waiting-and-retrying
  // correctly would have avoided.
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

// Structured operational logging — one line per authentication attempt,
// visible in the Edge Function logs. Originally added as temporary
// instrumentation while diagnosing the invalid_credentials/rate-limit
// misclassification bug; kept as permanent production logging because it is
// the only place the DECISION (why this attempt was classified the way it
// was, and whether that classification moved the counter or the lock) is
// recorded in one line. That is exactly what was missing when this class of
// bug had to be diagnosed from the outside.
//
// Safe for production: no password, no token, no session material is ever
// passed in — only the email, the upstream error code, and the outcome. The
// email is already stored in audit_logs for the same events, so this adds no
// new category of data. Deliberately kept separate from logAudit(), which
// writes the durable, queryable audit_logs trail; this is the ephemeral
// operational view of the same events.
function logAttempt(entry: {
  email: string
  supabaseErrorCode: string | null
  httpStatus: number
  decision: string
  attemptsIncremented: boolean
  accountLocked: boolean
  loginSucceeded: boolean
}) {
  console.log(
    JSON.stringify({
      tag: 'auth-login-attempt',
      timestamp: new Date().toISOString(),
      ...entry,
    }),
  )
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

/** Post-increment lockout state returned by the register_failed_login SQL
 * function (migration 20260731000008). `out_just_locked` is true only for
 * the single call that flipped the account into a locked state. */
interface FailedLoginCounter {
  out_attempts: number
  out_locked_at: string | null
  out_lock_expires_at: string | null
  out_just_locked: boolean
}

async function handleLogin(
  admin: SupabaseClient,
  email: string,
  password: string,
  clientIp: string,
  userAgent: string,
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
      metadata: { ip: clientIp, userAgent, reason: 'no_such_account' },
    })
    logAttempt({
      email,
      supabaseErrorCode: null,
      httpStatus: 401,
      decision: 'no_such_account',
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: false,
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
      // Compare-and-swap, not a blind write: `.not('locked_at','is',null)`
      // makes clearing the lock conditional on it still being set. Under
      // Postgres' READ COMMITTED isolation a concurrent caller that blocks
      // on this row re-evaluates that predicate against the winner's
      // committed version, sees locked_at IS NULL, and updates zero rows.
      // So exactly one request "discovers" the expiry and writes the audit
      // entry, while the others simply proceed to the credential check.
      //
      // Without the guard every concurrent request wrote its own
      // account.unlocked row for a single expiry event — measured against
      // the deployed function: 4 simultaneous logins produced 2 entries.
      // The column values converged correctly either way, so this was never
      // data corruption; it was a false security-audit trail, which for an
      // append-only audit log is its own kind of wrong.
      const { data: unlockedRows } = await admin
        .from('profiles')
        .update({
          locked_at: null,
          lock_expires_at: null,
          failed_login_attempts: 0,
        })
        .eq('id', profile.id)
        .not('locked_at', 'is', null)
        .select('id')

      if (unlockedRows && unlockedRows.length > 0) {
        await logAudit(admin, {
          actorId: profile.id,
          targetId: profile.id,
          targetEmail: profile.email,
          action: 'account.unlocked',
          success: true,
          metadata: { ip: clientIp, userAgent, reason: 'expired' },
        })
      }

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
        metadata: { ip: clientIp, userAgent, reason: 'locked' },
      })
      logAttempt({
        email: profile.email,
        supabaseErrorCode: null,
        httpStatus: 403,
        decision: 'blocked_already_locked',
        attemptsIncremented: false,
        accountLocked: true,
        loginSucceeded: false,
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
      metadata: { ip: clientIp, userAgent, reason: 'disabled' },
    })
    logAttempt({
      email: profile.email,
      supabaseErrorCode: null,
      httpStatus: 403,
      decision: 'blocked_disabled',
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: false,
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
    // Every successful authentication clears the whole lockout state, per
    // spec. This is an absolute write (not read-modify-write), so unlike the
    // failure path it has no concurrency hazard — two simultaneous
    // successful logins both write the same three values.
    //
    // The result is checked and retried rather than fired and forgotten: if
    // this silently failed, the user would be let in (correctly — they did
    // authenticate) but with a stale non-zero counter that could later lock
    // a perfectly good account out of nowhere. A failure here never blocks
    // the login itself; it is surfaced loudly instead, since the credentials
    // were genuinely correct and refusing entry would be the worse outcome.
    let resetOk = false
    for (let attempt = 0; attempt < 2 && !resetOk; attempt++) {
      const { error: resetError } = await admin
        .from('profiles')
        .update({
          failed_login_attempts: 0,
          locked_at: null,
          lock_expires_at: null,
        })
        .eq('id', profile.id)
      if (resetError) {
        console.error(
          `failed resetting lockout state on successful login (attempt ${attempt + 1}):`,
          resetError,
        )
        continue
      }
      resetOk = true
    }

    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: 'login.success',
      success: true,
      metadata: { ip: clientIp, userAgent, counterReset: resetOk },
    })
    logAttempt({
      email: profile.email,
      supabaseErrorCode: null,
      httpStatus: 200,
      decision: resetOk ? 'success' : 'success_counter_reset_failed',
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: true,
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

  // signInWithPassword can fail for reasons that have nothing to do with the
  // password being wrong — most notably GoTrue's own per-IP sign-in rate
  // limit (error code 'over_request_rate_limit', confirmed by hammering the
  // real token endpoint: it trips after ~40 attempts in a short window from
  // one IP and returns this code, completely distinct from
  // 'invalid_credentials'). Two browsers on the same machine/network share
  // that IP, so a burst of attempts in one can exhaust the budget the other
  // is still relying on.
  //
  // Every branch below this point used to treat ANY signInError identically
  // to a wrong password — incrementing failed_login_attempts and returning
  // the generic "Invalid email or password" message even when GoTrue never
  // actually evaluated the credentials at all. That meant a correct password
  // could get counted as a failure (and could eventually lock a perfectly
  // good account) purely because of upstream rate limiting or a transient
  // GoTrue error. Only a confirmed 'invalid_credentials' result is treated
  // as a real wrong-password attempt from here on; everything else is
  // reported honestly and leaves failed_login_attempts/locked_at untouched.
  //
  // The decision itself lives in _shared/authErrors.ts as a pure function so
  // every branch — including the 5xx and socket-failure cases that can't be
  // provoked on demand against a live GoTrue — is directly unit-tested
  // (authErrors.test.ts). `countsAsFailedAttempt` is true for exactly one
  // classification, invalid_credentials, and it is the only thing standing
  // between an upstream hiccup and a locked-out user.
  //
  // A null signInError reaching here would mean "no error and no session",
  // which the classifier also treats as non-counting rather than trusting it.
  const failure = classifySignInFailure(signInError)

  if (!failure.countsAsFailedAttempt) {
    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: UPSTREAM_ERROR_ACTION,
      success: false,
      metadata: {
        ip: clientIp,
        userAgent,
        reason: failure.kind,
        upstreamCode: signInError?.code ?? null,
        upstreamStatus: signInError?.status ?? null,
        upstreamMessage: signInError?.message ?? null,
      },
    })
    logAttempt({
      email: profile.email,
      supabaseErrorCode: signInError?.code ?? null,
      httpStatus: failure.httpStatus,
      decision: failure.kind,
      attemptsIncremented: false,
      accountLocked: false,
      loginSucceeded: false,
    })
    return json({ error: failure.userMessage }, failure.httpStatus, cors)
  }

  // Wrong password from here on — the ONE code path in this whole function
  // that may increment failed_login_attempts.
  //
  // The increment and the lock decision are done by a single server-side
  // statement (register_failed_login, see migration 20260731000008) rather
  // than read-here/write-there. The previous read-modify-write lost
  // concurrent increments: measured against the deployed function, 5
  // simultaneous wrong passwords left the counter at 1 and the account
  // unlocked, so firing guesses in parallel bypassed the 3-strike lock
  // entirely. Postgres' row lock inside that function serializes concurrent
  // callers, so each attempt now counts exactly once.
  //
  // super_admin still never locks — enforced by passing p_can_lock=false, so
  // the counter still moves (for visibility) but no lock is ever stamped.
  // Cast through `unknown`: the Supabase clients in these Edge Functions are
  // created without a generated `Database` generic, so every table and RPC
  // signature infers as `never` (the same reason the .update()/.insert()
  // calls elsewhere in this file are untyped). Naming the shape here at
  // least keeps this call site's contract with the SQL function explicit.
  const { data: counterRows, error: counterError } = await (
    admin.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: FailedLoginCounter[] | null; error: unknown }>
  )('register_failed_login', {
    p_user_id: profile.id,
    p_max_attempts: MAX_FAILED_ATTEMPTS,
    // Chosen fresh on every call, per spec — not a fixed duration. Only
    // actually applied by the function on the transition into a lock.
    p_lock_duration_ms: randomLockDurationMs(),
    p_can_lock: !isSuperAdmin,
  })

  if (counterError) {
    // The credentials WERE checked and were wrong, so this must not report
    // success — but the attempt could not be recorded, which is a real
    // integrity problem worth surfacing in logs rather than swallowing.
    console.error('register_failed_login failed:', counterError)
  }

  const counter = counterRows?.[0]
  const attempts: number | null = counter?.out_attempts ?? null
  const lockExpiresAt: string | null = counter?.out_lock_expires_at ?? null
  const justLocked: boolean = counter?.out_just_locked === true
  const isLocked: boolean = counter?.out_locked_at != null

  await logAudit(admin, {
    actorId: profile.id,
    targetId: profile.id,
    targetEmail: profile.email,
    action: 'login.failure',
    success: false,
    metadata: { ip: clientIp, userAgent, attempts },
  })

  // Only the call that actually flipped the account into a locked state
  // writes the account.locked entry — otherwise a concurrent burst would
  // write several duplicate lock entries for one single lock.
  if (justLocked && lockExpiresAt) {
    await logAudit(admin, {
      actorId: profile.id,
      targetId: profile.id,
      targetEmail: profile.email,
      action: 'account.locked',
      success: true,
      metadata: {
        ip: clientIp,
        userAgent,
        reason: 'max_failed_attempts',
        lockExpiresAt,
        lockDurationMinutes: remainingLockMinutes(lockExpiresAt),
      },
    })
  }

  if (isLocked && lockExpiresAt) {
    logAttempt({
      email: profile.email,
      supabaseErrorCode: 'invalid_credentials',
      httpStatus: 403,
      decision: justLocked
        ? 'wrong_password_triggered_lock'
        : 'wrong_password_while_locked',
      attemptsIncremented: true,
      accountLocked: true,
      loginSucceeded: false,
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

  logAttempt({
    email: profile.email,
    supabaseErrorCode: 'invalid_credentials',
    httpStatus: 401,
    decision: 'wrong_password',
    attemptsIncremented: true,
    accountLocked: false,
    loginSucceeded: false,
  })
  return json({ error: GENERIC_ERROR }, 401, cors)
}
