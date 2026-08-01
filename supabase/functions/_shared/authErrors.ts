// Classification of a failed signInWithPassword() result — the single place
// that decides whether an authentication failure was the CALLER'S fault (a
// wrong password, which must count toward lockout) or the SYSTEM'S (rate
// limiting, an upstream outage, a network blip — none of which may ever
// count).
//
// Extracted out of auth-login deliberately. The original bug in this area
// was that no such distinction existed at all: every signInWithPassword
// error was treated as a wrong password, so an upstream rate limit both
// incremented the lockout counter and told the user their password was
// wrong. That was only diagnosable from the outside, by inference, because
// the decision was buried inline in a network-dependent code path with no
// way to exercise its branches directly.
//
// As a pure function over a plain {code, status, message} shape, every
// branch — including the ones that are impractical to provoke against a live
// GoTrue (5xx, socket failure) — is directly testable. See authErrors.test.ts.

/** The user-facing strings. Single-sourced here so the message and the
 * decision that selects it cannot drift apart. */
export const AUTH_MESSAGES = {
  /** Deliberately identical for "no such email" and "wrong password" — never
   * reveal which. */
  invalidCredentials: 'Invalid email or password.',
  rateLimited:
    'Too many sign-in attempts. Please wait a few minutes and try again.',
  /** Must never claim the credentials were wrong: in these cases they were
   * never actually evaluated. */
  unavailable:
    'Authentication service temporarily unavailable. Please try again later.',
} as const

export type SignInFailureKind =
  | 'invalid_credentials'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'unexpected'

export interface SignInFailureClassification {
  kind: SignInFailureKind
  /** The ONLY flag that may gate a failed_login_attempts increment. */
  countsAsFailedAttempt: boolean
  httpStatus: number
  userMessage: string
}

/** The subset of a Supabase AuthError this decision depends on. */
export interface SignInErrorLike {
  code?: string | null
  status?: number | null
  message?: string | null
}

/**
 * Maps a signInWithPassword() error onto a handling decision.
 *
 * Only a confirmed `invalid_credentials` from GoTrue counts as a failed
 * attempt. Everything else — including an error shape this function does not
 * recognise — fails safe: it does not count, and it does not claim the
 * password was wrong. An unknown error meaning "wrong password" would at
 * worst let someone have extra guesses; an unknown error miscounted as a
 * wrong password locks innocent people out of their accounts, which is the
 * strictly worse failure and the one that actually happened here.
 */
export function classifySignInFailure(
  error: SignInErrorLike | null | undefined,
): SignInFailureClassification {
  const code = error?.code ?? null
  const status = error?.status ?? null

  if (code === 'invalid_credentials') {
    return {
      kind: 'invalid_credentials',
      countsAsFailedAttempt: true,
      httpStatus: 401,
      userMessage: AUTH_MESSAGES.invalidCredentials,
    }
  }

  if (code === 'over_request_rate_limit') {
    return {
      kind: 'rate_limited',
      countsAsFailedAttempt: false,
      httpStatus: 429,
      userMessage: AUTH_MESSAGES.rateLimited,
    }
  }

  // A 429 without that specific code (a proxy/gateway limiter in front of
  // GoTrue, say) is still rate limiting and still must not count.
  if (status === 429) {
    return {
      kind: 'rate_limited',
      countsAsFailedAttempt: false,
      httpStatus: 429,
      userMessage: AUTH_MESSAGES.rateLimited,
    }
  }

  if (typeof status === 'number' && status >= 500) {
    return {
      kind: 'server_error',
      countsAsFailedAttempt: false,
      httpStatus: 503,
      userMessage: AUTH_MESSAGES.unavailable,
    }
  }

  // supabase-js surfaces a transport failure as AuthRetryableFetchError with
  // status 0, and a pre-response throw can arrive with no status at all.
  if (status === null || status === 0) {
    return {
      kind: 'network_error',
      countsAsFailedAttempt: false,
      httpStatus: 503,
      userMessage: AUTH_MESSAGES.unavailable,
    }
  }

  return {
    kind: 'unexpected',
    countsAsFailedAttempt: false,
    httpStatus: 503,
    userMessage: AUTH_MESSAGES.unavailable,
  }
}
