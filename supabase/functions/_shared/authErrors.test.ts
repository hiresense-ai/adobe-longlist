// Exhaustive tests for the sign-in failure classifier.
//
// The whole point of this file: the branches that matter most here (upstream
// 5xx, socket failure, unrecognised error shapes) are the ones that cannot be
// provoked on demand against a live GoTrue. Testing the decision as a pure
// function is what makes "only invalid_credentials increments the counter" a
// verified property rather than a claim.
//
// Run: deno test supabase/functions/_shared/authErrors.test.ts

import {
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  AUTH_MESSAGES,
  classifySignInFailure,
  type SignInErrorLike,
} from './authErrors.ts'

Deno.test(
  'invalid_credentials is the only kind that counts as a failed attempt',
  () => {
    const r = classifySignInFailure({
      code: 'invalid_credentials',
      status: 400,
      message: 'Invalid login credentials',
    })
    assertEquals(r.kind, 'invalid_credentials')
    assertEquals(r.countsAsFailedAttempt, true)
    assertEquals(r.httpStatus, 401)
    assertEquals(r.userMessage, AUTH_MESSAGES.invalidCredentials)
  },
)

Deno.test(
  'over_request_rate_limit never counts and never claims a bad password',
  () => {
    // Exactly the shape captured from the live endpoint:
    // {"code":429,"error_code":"over_request_rate_limit","msg":"Request rate limit reached"}
    const r = classifySignInFailure({
      code: 'over_request_rate_limit',
      status: 429,
      message: 'Request rate limit reached',
    })
    assertEquals(r.kind, 'rate_limited')
    assertEquals(r.countsAsFailedAttempt, false)
    assertEquals(r.httpStatus, 429)
    assertEquals(r.userMessage, AUTH_MESSAGES.rateLimited)
    assertNotEquals(r.userMessage, AUTH_MESSAGES.invalidCredentials)
  },
)

Deno.test('a bare 429 with no recognised code is still rate limiting', () => {
  const r = classifySignInFailure({ code: null, status: 429 })
  assertEquals(r.kind, 'rate_limited')
  assertEquals(r.countsAsFailedAttempt, false)
})

Deno.test('server errors do not count', () => {
  for (const status of [500, 502, 503, 504]) {
    const r = classifySignInFailure({ code: 'unexpected_failure', status })
    assertEquals(r.kind, 'server_error', `status ${status}`)
    assertEquals(r.countsAsFailedAttempt, false, `status ${status}`)
    assertEquals(r.httpStatus, 503)
    assertEquals(r.userMessage, AUTH_MESSAGES.unavailable)
  }
})

Deno.test('network failures do not count (status 0, null, or absent)', () => {
  const shapes: SignInErrorLike[] = [
    { code: undefined, status: 0, message: 'Failed to fetch' },
    { code: null, status: null, message: 'Network request failed' },
    {},
  ]
  for (const shape of shapes) {
    const r = classifySignInFailure(shape)
    assertEquals(r.kind, 'network_error', JSON.stringify(shape))
    assertEquals(r.countsAsFailedAttempt, false, JSON.stringify(shape))
    assertEquals(r.userMessage, AUTH_MESSAGES.unavailable)
  }
})

Deno.test('null/undefined error fails safe rather than counting', () => {
  for (const e of [null, undefined]) {
    const r = classifySignInFailure(e)
    assertEquals(r.countsAsFailedAttempt, false)
    assertNotEquals(r.userMessage, AUTH_MESSAGES.invalidCredentials)
  }
})

Deno.test(
  'unrecognised 4xx codes fail safe: no increment, no bad-password claim',
  () => {
    // Real codes from auth-js ErrorCode that are NOT wrong-password.
    const codes = [
      'user_banned',
      'email_not_confirmed',
      'validation_failed',
      'bad_json',
      'request_timeout',
      'signup_disabled',
      'weak_password',
      'some_code_that_does_not_exist_yet',
    ]
    for (const code of codes) {
      const r = classifySignInFailure({ code, status: 400 })
      assertEquals(r.countsAsFailedAttempt, false, code)
      assertNotEquals(r.userMessage, AUTH_MESSAGES.invalidCredentials, code)
      assertEquals(r.httpStatus, 503, code)
    }
  },
)

Deno.test(
  'no classification other than invalid_credentials ever counts',
  () => {
    const everyShape: SignInErrorLike[] = [
      { code: 'invalid_credentials', status: 400 },
      { code: 'over_request_rate_limit', status: 429 },
      { code: 'unexpected_failure', status: 500 },
      { code: null, status: 0 },
      { code: 'user_banned', status: 403 },
      {},
    ]
    for (const shape of everyShape) {
      const r = classifySignInFailure(shape)
      assertEquals(
        r.countsAsFailedAttempt,
        r.kind === 'invalid_credentials',
        `counting must track kind exactly: ${JSON.stringify(shape)}`,
      )
    }
  },
)

Deno.test('the three user-facing messages are distinct', () => {
  const all = [
    AUTH_MESSAGES.invalidCredentials,
    AUTH_MESSAGES.rateLimited,
    AUTH_MESSAGES.unavailable,
  ]
  assertEquals(new Set(all).size, 3)
})
