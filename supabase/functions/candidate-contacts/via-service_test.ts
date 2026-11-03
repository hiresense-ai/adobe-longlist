// deno test --allow-env supabase/functions/candidate-contacts/via-service_test.ts
//
// HIR-537: with CONTACT_VENDORS_VIA_SERVICE on, the reveal asks the shared
// contact service for every vendor call and Lyca calls no vendor itself.
// Invented people only (john-doe, example.com).
import {
  askWithPending,
  contactVendorsViaService,
  itemsOf,
  kindsToAskAgain,
  nextServiceRow,
  parseServiceAnswer,
  runViaService,
  SERVICE_UNREACHABLE,
  serviceKindState,
  serviceLookedUp,
  ServiceUnavailableError,
  VIA_SERVICE_MIN_TIMEOUT_MS,
  viaServiceTimeoutMs,
  type ServiceAnswer,
  type ServiceRowFields,
  type ViaServiceDeps,
} from './via-service.ts'
import type { PersonRows, StoredRow } from './flow.ts'
import type { ContactKind } from './vendors.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const URL_ = 'https://www.linkedin.com/in/john-doe/'
const SERVICE = 'http://contact-service.test'
const SALESQL = 'http://salesql.test'
const BETTERCONTACT = 'http://bettercontact.test'

type Call = { url: string; body: Record<string, unknown> }

/** Every fetch is recorded. The service answers from `answers` in order; any vendor host is an error. */
function stubFetch(answers: Array<() => Response>): Call[] {
  const calls: Call[] = []
  let next = 0
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    if (!url.startsWith(SERVICE)) {
      return new Response('vendor must not be called', { status: 599 })
    }
    const answer = answers[next++]
    if (!answer) throw new Error(`unexpected service call ${url}`)
    return answer()
  }) as typeof fetch
  return calls
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

/** The setting on, the service configured, and Lyca's own vendors configured (they must still not be called). */
const ON: Record<string, string | null> = {
  CONTACT_VENDORS_VIA_SERVICE: 'true',
  CONTACT_ENRICHMENT_URL: `${SERVICE}/`,
  CONTACT_ENRICHMENT_API_KEY: 'lyca-test-key',
  CONTACT_ENRICHMENT_TIMEOUT_MS: null,
  SALESQL_API_KEY: 'fake-salesql-key',
  SALESQL_API_URL: SALESQL,
  BETTERCONTACT_API_KEY: 'fake-bettercontact-key',
  BETTERCONTACT_API_URL: BETTERCONTACT,
}

/** A test with the setting on; the environment and fetch are put back after it. */
function onTest(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const before = Object.fromEntries(
      Object.keys(ON).map((k) => [k, Deno.env.get(k) ?? null]),
    )
    const realFetch = globalThis.fetch
    const put = (env: Record<string, string | null>) => {
      for (const [k, v] of Object.entries(env)) {
        if (v === null) Deno.env.delete(k)
        else Deno.env.set(k, v)
      }
    }
    put(ON)
    try {
      await fn()
    } finally {
      put(before)
      globalThis.fetch = realFetch
    }
  })
}

function noVendorCalls(calls: Call[]) {
  assertEquals(
    calls.filter((c) => !c.url.startsWith(SERVICE)).map((c) => c.url),
    [],
  )
}

type Verdict = Awaited<ReturnType<ViaServiceDeps['load']>>['verdicts'][number]

/** Lyca's tables for one person, in memory. */
function memory(rows: PersonRows = {}, verdicts: Verdict[] = []) {
  const state = { rows: { ...rows }, verdicts, writes: 0, limitChecks: 0 }
  const sleeps: number[] = []
  const deps: ViaServiceDeps = {
    load: () =>
      Promise.resolve({
        rows: structuredClone(state.rows),
        verdicts: state.verdicts,
      }),
    saveServiceRow: (fields: ServiceRowFields) => {
      state.writes++
      state.rows.shared = structuredClone(fields) as StoredRow
      return Promise.resolve()
    },
    enforceLimit: () => {
      state.limitChecks++
      return Promise.resolve()
    },
    sleep: (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  }
  return { state, deps, sleeps }
}

const view = (rows: PersonRows, verdicts: Verdict[], kind: ContactKind) =>
  serviceKindState(kind, itemsOf(kind, rows, verdicts), rows)

// --- the setting -------------------------------------------------------------

Deno.test(
  'setting: only the exact text "true" turns it on; unset is off',
  () => {
    Deno.env.delete('CONTACT_VENDORS_VIA_SERVICE')
    assertEquals(contactVendorsViaService(), false)
    for (const off of ['false', '', '1', 'yes', 'on']) {
      Deno.env.set('CONTACT_VENDORS_VIA_SERVICE', off)
      assertEquals([off, contactVendorsViaService()], [off, false])
    }
    for (const on of ['true', ' TRUE ', 'True']) {
      Deno.env.set('CONTACT_VENDORS_VIA_SERVICE', on)
      assertEquals([on, contactVendorsViaService()], [on, true])
    }
    Deno.env.delete('CONTACT_VENDORS_VIA_SERVICE')
  },
)

Deno.test('setting on: the service gets at least 20 s', () => {
  Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
  assertEquals(viaServiceTimeoutMs(), VIA_SERVICE_MIN_TIMEOUT_MS)
  assertEquals(VIA_SERVICE_MIN_TIMEOUT_MS, 20_000)
  Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', '8000')
  assertEquals(viaServiceTimeoutMs(), 20_000)
  Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', '30000')
  assertEquals(viaServiceTimeoutMs(), 30_000)
  Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
})

// --- "Get contact" ------------------------------------------------------------

onTest(
  "a hit: one lookup, Lyca's order at the service, no vendor called by Lyca",
  async () => {
    const calls = stubFetch([
      json({
        linkedin_key: 'linkedin.com/in/john-doe',
        found_in: 'salesql',
        found_in_by_kind: { email: 'salesql', phone: 'ziplabs' },
        has: { email: true, phone: true },
        emails: [
          {
            value: 'john.doe@example.com',
            status: 'unknown',
            verified: true,
            check: {
              result: 'valid',
              reason: null,
              checked_at: '2026-11-03T08:00:00.000Z',
            },
          },
          {
            value: 'old.john@example.com',
            status: 'bad',
            verified: null,
            check: { result: 'unknown', reason: null, checked_at: null },
          },
        ],
        phones: [{ value: '+919876543210', status: 'unknown', verified: null }],
      }),
    ])
    const { state, deps } = memory()
    await runViaService(deps, URL_, 'lookup', [])

    assertEquals(calls.length, 1)
    assertEquals(calls[0]!.url, `${SERVICE}/v1/contacts/lookup`)
    // Without ziplabs:false, so the service runs Lyca's whole order.
    assertEquals(calls[0]!.body, {
      linkedin_url: URL_,
      kinds: ['email', 'phone'],
    })
    noVendorCalls(calls)
    assertEquals(state.limitChecks, 1)

    // The bad value is not kept; the email keeps the service's check result.
    assertEquals(state.rows.shared, {
      status: 'found',
      emails: [
        {
          value: 'john.doe@example.com',
          type: null,
          status: 'Valid',
          check: 'valid',
        },
      ],
      phones: [{ value: '+919876543210', type: null, valid: null }],
      email_searched: false,
      phone_searched: false,
      pending_kinds: null,
      error: null,
    })
    assertEquals(serviceLookedUp(state.rows), true)
    assertEquals(view(state.rows, [], 'email'), {
      searching: false,
      canFind: false,
      exhausted: false,
      unavailable: false,
    })
    // Looked up: a second "Get contact" asks nothing.
    await runViaService(deps, URL_, 'lookup', [])
    assertEquals(calls.length, 1)
  },
)

onTest(
  'a miss: "not found" for both, nothing more to find, no second call',
  async () => {
    const calls = stubFetch([
      json({
        found_in: 'none',
        found_in_by_kind: { email: 'none', phone: 'none' },
        has: { email: false, phone: false },
        emails: [],
        phones: [],
      }),
    ])
    const { state, deps } = memory()
    await runViaService(deps, URL_, 'lookup', [])
    assertEquals(state.rows.shared?.status, 'not_found')
    assertEquals(
      [state.rows.shared?.email_searched, state.rows.shared?.phone_searched],
      [true, true],
    )
    assertEquals(serviceLookedUp(state.rows), true)
    for (const kind of ['email', 'phone'] as const) {
      assertEquals(view(state.rows, [], kind), {
        searching: false,
        canFind: false,
        exhausted: true,
        unavailable: false,
      })
    }
    assertEquals(kindsToAskAgain(state.rows), [])
    await runViaService(deps, URL_, 'lookup', [])
    await runViaService(deps, URL_, 'backup', ['email', 'phone'])
    assertEquals(calls.length, 1)
    noVendorCalls(calls)
  },
)

onTest(
  'pending, then a hit: waits retry_after_ms and asks once more',
  async () => {
    const calls = stubFetch([
      json({
        has: { email: true, phone: false },
        pending: ['phone'],
        retry_after_ms: 1500,
        emails: [
          { value: 'john.doe@example.com', status: 'unknown', verified: null },
        ],
        phones: [],
      }),
      json({
        has: { email: true, phone: true },
        emails: [
          { value: 'john.doe@example.com', status: 'unknown', verified: null },
        ],
        phones: [
          { value: '+91 98765 43210', status: 'unknown', verified: true },
        ],
      }),
    ])
    const { state, deps, sleeps } = memory()
    await runViaService(deps, URL_, 'lookup', [])
    assertEquals(sleeps, [1500])
    assertEquals(calls.length, 2)
    assertEquals(calls[1]!.body, calls[0]!.body)
    noVendorCalls(calls)
    assertEquals(state.rows.shared?.status, 'found')
    assertEquals(state.rows.shared?.pending_kinds, null)
    assertEquals(
      state.rows.shared?.phones.map((p) => p.value),
      ['+91 98765 43210'],
    )
    assertEquals(state.writes, 1)
  },
)

onTest(
  'still pending after the second ask: "searching", and refresh asks for that kind only',
  async () => {
    const pendingPhone = json({
      has: { email: true, phone: false },
      pending: ['phone'],
      retry_after_ms: 9000,
      emails: [
        { value: 'john.doe@example.com', status: 'unknown', verified: null },
      ],
      phones: [],
    })
    const calls = stubFetch([
      pendingPhone,
      pendingPhone,
      json({
        has: { phone: true },
        phones: [{ value: '+919876543210', status: 'unknown', verified: null }],
      }),
    ])
    const { state, deps, sleeps } = memory()
    await runViaService(deps, URL_, 'lookup', [])
    assertEquals(sleeps, [5000]) // capped at 5 s
    assertEquals(state.rows.shared?.pending_kinds, ['phone'])
    // Pending is never "not found" and never "every source asked".
    assertEquals(state.rows.shared?.phone_searched, false)
    assertEquals(view(state.rows, [], 'phone'), {
      searching: true,
      canFind: false,
      exhausted: false,
      unavailable: false,
    })
    await runViaService(deps, URL_, 'refresh', [])
    assertEquals(calls[2]!.body, { linkedin_url: URL_, kinds: ['phone'] })
    assertEquals(state.rows.shared?.pending_kinds, null)
    assertEquals(
      state.rows.shared?.phones.map((p) => p.value),
      ['+919876543210'],
    )
    assertEquals(
      state.rows.shared?.emails.map((e) => e.value),
      ['john.doe@example.com'],
    )
    noVendorCalls(calls)
  },
)

onTest(
  'a 503 outage: "temporarily unavailable", nothing final, asked again on "Try again"',
  async () => {
    for (const code of ['vendors_unavailable', 'store_unavailable']) {
      const calls = stubFetch([
        json({ error: { code, message: 'down' } }, 503),
        json({
          has: { email: true, phone: false },
          emails: [
            {
              value: 'john.doe@example.com',
              status: 'unknown',
              verified: null,
            },
          ],
          phones: [],
        }),
      ])
      const { state, deps } = memory()
      await runViaService(deps, URL_, 'lookup', [])
      assertEquals(state.rows.shared, {
        status: 'error',
        emails: [],
        phones: [],
        email_searched: false,
        phone_searched: false,
        pending_kinds: null,
        error: SERVICE_UNREACHABLE,
      })
      assertEquals(serviceLookedUp(state.rows), false)
      for (const kind of ['email', 'phone'] as const) {
        const s = view(state.rows, [], kind)
        assertEquals([code, s.unavailable, s.exhausted], [code, true, false])
      }
      // "Try again" ("Get contact" while not looked up) asks the service again.
      await runViaService(deps, URL_, 'lookup', [])
      assertEquals(calls.length, 2)
      assertEquals(state.rows.shared?.status, 'found')
      assertEquals(state.rows.shared?.error, null)
      noVendorCalls(calls)
    }
  },
)

onTest(
  'a timeout or a refused key is an outage too, never "not found"',
  async () => {
    for (const fail of [
      () => {
        throw new DOMException('timed out', 'TimeoutError')
      },
      json({ error: { code: 'unauthenticated' } }, 401),
    ]) {
      stubFetch([fail as () => Response])
      const { state, deps } = memory()
      await runViaService(deps, URL_, 'lookup', [])
      assertEquals(state.rows.shared?.status, 'error')
      assertEquals(state.rows.shared?.email_searched, false)
    }
  },
)

onTest(
  'an outage on a person with a value: the value stays, the empty kind is "unavailable"',
  async () => {
    const calls = stubFetch([
      json({ error: { code: 'vendors_unavailable' } }, 503),
    ])
    const { state, deps } = memory({
      shared: {
        status: 'found',
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
        email_searched: false,
        phone_searched: false,
        pending_kinds: null,
        error: SERVICE_UNREACHABLE, // the phone's last call failed
      },
    })
    assertEquals(kindsToAskAgain(state.rows), ['phone'])
    await runViaService(deps, URL_, 'lookup', [])
    assertEquals(calls[0]!.body, { linkedin_url: URL_, kinds: ['phone'] })
    assertEquals(state.rows.shared?.status, 'found')
    assertEquals(state.rows.shared?.emails.length, 1)
    assertEquals(view(state.rows, [], 'phone').unavailable, true)
    assertEquals(view(state.rows, [], 'phone').canFind, true) // "Try again"
    assertEquals(view(state.rows, [], 'email').unavailable, false)
  },
)

// --- "Find another" ----------------------------------------------------------

const foundEmail: PersonRows = {
  shared: {
    status: 'found',
    emails: [{ value: 'john.doe@example.com', type: null, status: null }],
    phones: [{ value: '+919876543210', type: null, valid: null }],
    email_searched: false,
    phone_searched: false,
    pending_kinds: null,
    error: null,
  },
}
const thumbsDown: Verdict[] = [
  {
    contact_kind: 'email',
    contact_value: 'John.Doe@example.com',
    verdict: 'bad',
    reason: 'bounced',
  },
]

onTest(
  'find another: after a 👎, POST find-another with what was shown; a new value is added',
  async () => {
    assertEquals(view(foundEmail, [], 'email').canFind, false) // no 👎 yet
    assertEquals(view(foundEmail, thumbsDown, 'email').canFind, true)
    const calls = stubFetch([
      json({
        found_in: 'bettercontact',
        found_in_by_kind: { email: 'bettercontact' },
        has: { email: true },
        exhausted: false,
        emails: [
          {
            value: 'j.doe@example.com',
            status: 'unknown',
            verified: null,
            check: {
              result: 'invalid',
              reason: 'mailbox_not_found',
              checked_at: null,
            },
          },
          { value: 'john.doe@example.com', status: 'bad', verified: true },
        ],
      }),
    ])
    const { state, deps } = memory(foundEmail, thumbsDown)
    await runViaService(deps, URL_, 'backup', ['email'])
    assertEquals(calls.length, 1)
    assertEquals(calls[0]!.url, `${SERVICE}/v1/contacts/find-another`)
    assertEquals(calls[0]!.body, {
      linkedin_url: URL_,
      kind: 'email',
      shown: ['john.doe@example.com'],
    })
    noVendorCalls(calls)
    // Shown with its check result kept, not hidden: Lyca runs no email check.
    assertEquals(state.rows.shared?.emails, [
      { value: 'john.doe@example.com', type: null, status: null },
      {
        value: 'j.doe@example.com',
        type: null,
        status: null,
        check: 'invalid',
      },
    ])
    const items = itemsOf('email', state.rows, thumbsDown)
    assertEquals(
      items.map((x) => [x.value, x.verdict, x.invalid]),
      [
        ['john.doe@example.com', 'bad', false],
        ['j.doe@example.com', null, false],
      ],
    )
    // Not exhausted: after a 👎 on the new one, Find another is offered again.
    assertEquals(state.rows.shared?.email_searched, false)
    assertEquals(view(state.rows, thumbsDown, 'email').canFind, true)
  },
)

onTest('find another: exhausted is "no more sources"', async () => {
  const calls = stubFetch([
    json({
      found_in: 'none',
      found_in_by_kind: { email: 'none' },
      has: { email: false },
      exhausted: true,
      emails: [
        { value: 'john.doe@example.com', status: 'bad', verified: true },
      ],
    }),
  ])
  const { state, deps } = memory(foundEmail, thumbsDown)
  await runViaService(deps, URL_, 'backup', ['email'])
  assertEquals(state.rows.shared?.email_searched, true)
  assertEquals(state.rows.shared?.phone_searched, false)
  assertEquals(view(state.rows, thumbsDown, 'email'), {
    searching: false,
    canFind: false,
    exhausted: true,
    unavailable: false,
  })
  // Asked no more.
  await runViaService(deps, URL_, 'backup', ['email'])
  assertEquals(calls.length, 1)
  noVendorCalls(calls)
})

onTest(
  'find another: an outage records nothing and answers "temporarily unavailable"',
  async () => {
    for (const answer of [
      json({ error: { code: 'vendors_unavailable' } }, 503),
      json({ error: { code: 'find_another_not_available' } }, 409),
    ]) {
      const calls = stubFetch([answer])
      const { state, deps } = memory(foundEmail, thumbsDown)
      let threw = false
      try {
        await runViaService(deps, URL_, 'backup', ['email'])
      } catch (err) {
        threw = err instanceof ServiceUnavailableError
      }
      assertEquals(threw, true)
      assertEquals(state.writes, 0)
      assertEquals(state.rows.shared, foundEmail.shared)
      noVendorCalls(calls)
    }
  },
)

onTest('find another: pending, then a value', async () => {
  const calls = stubFetch([
    json({
      has: { email: false },
      exhausted: false,
      pending: ['email'],
      retry_after_ms: 800,
      emails: [],
    }),
    json({
      has: { email: true },
      exhausted: false,
      emails: [
        { value: 'j.doe@example.com', status: 'unknown', verified: null },
      ],
    }),
  ])
  const { state, deps, sleeps } = memory(foundEmail, thumbsDown)
  await runViaService(deps, URL_, 'backup', ['email'])
  assertEquals(sleeps, [800])
  assertEquals(calls.length, 2)
  assertEquals(
    state.rows.shared?.emails.map((e) => e.value),
    ['john.doe@example.com', 'j.doe@example.com'],
  )
  noVendorCalls(calls)
})

onTest(
  "a person Lyca's own vendors found before the switch: 👎 goes to the service, not to SalesQL or BetterContact",
  async () => {
    const before: PersonRows = {
      shared: { status: 'not_found', emails: [], phones: [] },
      salesql: {
        status: 'found',
        emails: [
          { value: 'john.doe@example.com', type: 'Work', status: 'Valid' },
        ],
        phones: [{ value: '+91 98765 43210', type: 'Mobile', valid: true }],
      },
      bettercontact: {
        status: 'found',
        emails: [
          { value: 'jd@example.com', type: null, status: 'deliverable' },
        ],
        phones: [],
        email_searched: true,
        phone_searched: false,
      },
    }
    const verdicts: Verdict[] = [
      {
        contact_kind: 'email',
        contact_value: 'john.doe@example.com',
        verdict: 'bad',
        reason: 'bounced',
      },
      {
        contact_kind: 'email',
        contact_value: 'jd@example.com',
        verdict: 'bad',
        reason: 'bounced',
      },
    ]
    // Shown as before; every value takes 👍/👎; nothing to ask on "Get contact".
    assertEquals(serviceLookedUp(before), true)
    assertEquals(kindsToAskAgain(before), [])
    assertEquals(view(before, verdicts, 'email').canFind, true)
    assertEquals(view(before, verdicts, 'phone').canFind, false)
    const calls = stubFetch([
      json({ has: { email: false }, exhausted: true, emails: [] }),
    ])
    const { state, deps } = memory(before, verdicts)
    await runViaService(deps, URL_, 'lookup', [])
    await runViaService(deps, URL_, 'backup', ['email', 'phone'])
    assertEquals(calls.length, 1)
    assertEquals(calls[0]!.body, {
      linkedin_url: URL_,
      kind: 'email',
      shown: ['john.doe@example.com', 'jd@example.com'],
    })
    noVendorCalls(calls)
    // Lyca's own rows are untouched.
    assertEquals(state.rows.salesql, before.salesql)
    assertEquals(state.rows.bettercontact, before.bettercontact)
  },
)

onTest(
  '"Find email" for an empty kind no source answered: a lookup for that kind',
  async () => {
    const rows: PersonRows = {
      // Found by the store before the switch (no waterfall), phone never asked.
      shared: {
        status: 'found',
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
      },
    }
    assertEquals(view(rows, [], 'phone').canFind, true)
    const calls = stubFetch([json({ has: { phone: false }, phones: [] })])
    const { state, deps } = memory(rows)
    await runViaService(deps, URL_, 'backup', ['phone'])
    assertEquals(calls[0]!.url, `${SERVICE}/v1/contacts/lookup`)
    assertEquals(calls[0]!.body, { linkedin_url: URL_, kinds: ['phone'] })
    assertEquals(state.rows.shared?.phone_searched, true)
    assertEquals(view(state.rows, [], 'phone').canFind, false)
    noVendorCalls(calls)
  },
)

onTest('not configured: refused as unavailable, nothing called', async () => {
  Deno.env.delete('CONTACT_ENRICHMENT_URL')
  const calls = stubFetch([])
  const { state, deps } = memory()
  let threw = false
  try {
    await runViaService(deps, URL_, 'lookup', [])
  } catch (err) {
    threw = err instanceof ServiceUnavailableError
  }
  assertEquals([threw, calls.length, state.writes], [true, 0, 0])
})

// --- the pure parts -------------------------------------------------------------

Deno.test(
  'parse: the email check contract, bad values out, has derived for an older service',
  () => {
    const a = parseServiceAnswer(
      {
        emails: [
          {
            value: 'a@example.com',
            status: 'good',
            verified: true,
            check: { result: 'valid', reason: null, checked_at: null },
          },
          {
            value: 'b@example.com',
            status: 'unknown',
            verified: null,
            check: { result: 'nonsense' },
          },
          {
            value: 'c@example.com',
            status: 'bad',
            verified: true,
            check: { result: 'valid' },
          },
          { value: '', status: 'unknown' },
          { status: 'unknown' },
        ],
        phones: [
          { value: '+919876543210', status: 'unknown', verified: false },
        ],
      },
      ['email', 'phone'],
    )
    assertEquals(a, {
      emails: [
        { value: 'a@example.com', type: null, status: 'Valid', check: 'valid' },
        { value: 'b@example.com', type: null, status: null, check: null },
      ],
      phones: [{ value: '+919876543210', type: null, valid: false }],
      has: { email: true, phone: false },
      pending: [],
      retryAfterMs: null,
    })
  },
)

Deno.test(
  'askWithPending: a failed second ask keeps the first answer',
  async () => {
    let n = 0
    const first: ServiceAnswer = {
      emails: [],
      phones: [],
      has: { email: false },
      pending: ['email'],
      retryAfterMs: 500,
    }
    const answer = await askWithPending(
      () => {
        n++
        if (n === 1) return Promise.resolve(first)
        return Promise.reject(new Error('down'))
      },
      ['email'],
      () => Promise.resolve(),
    )
    assertEquals([n, answer], [2, first])
  },
)

Deno.test(
  'nextServiceRow: a fresh check replaces the held one; one phone, two spellings',
  () => {
    const row = nextServiceRow(
      {
        status: 'found',
        emails: [{ value: 'John.Doe@example.com', type: null, status: null }],
        phones: [{ value: '+91 98765 43210', type: null, valid: null }],
      },
      ['email', 'phone'],
      {
        answer: {
          emails: [
            {
              value: 'john.doe@example.com',
              type: null,
              status: null,
              check: 'invalid',
            },
          ],
          phones: [{ value: '9876543210', type: null, valid: null }],
          has: { email: true, phone: true },
          pending: [],
          retryAfterMs: null,
        },
      },
    )
    assertEquals(row.emails, [
      {
        value: 'John.Doe@example.com',
        type: null,
        status: null,
        check: 'invalid',
      },
    ])
    assertEquals(row.phones, [
      { value: '+91 98765 43210', type: null, valid: null },
    ])
  },
)

// --- name and company for BetterContact (contact-enrichment #19/#20) ----------

onTest(
  'lookup and find-another send name and company, as Lyca sends BetterContact; empty ones are left out',
  async () => {
    const calls = stubFetch([
      json({
        has: { email: true, phone: false },
        emails: [
          { value: 'john.doe@example.com', status: 'unknown', verified: null },
        ],
        phones: [],
      }),
      json({ has: { email: false }, exhausted: true, emails: [] }),
      json({ has: { email: false, phone: false }, emails: [], phones: [] }),
    ])
    const john = {
      linkedinUrl: URL_,
      name: '  John  Doe (PhD) ',
      company: ' Example Corp ',
    }
    const { deps, state } = memory()
    await runViaService(deps, john, 'lookup', [])
    assertEquals(calls[0]!.body, {
      linkedin_url: URL_,
      name: 'John Doe PhD',
      company: 'Example Corp',
      kinds: ['email', 'phone'],
    })
    state.verdicts = thumbsDown
    await runViaService(deps, john, 'backup', ['email'])
    assertEquals(calls[1]!.url, `${SERVICE}/v1/contacts/find-another`)
    assertEquals(calls[1]!.body, {
      linkedin_url: URL_,
      name: 'John Doe PhD',
      company: 'Example Corp',
      kind: 'email',
      shown: ['john.doe@example.com'],
    })
    // No company, a name with nothing left after cleaning: only the URL.
    const { deps: other } = memory()
    await runViaService(
      other,
      { linkedinUrl: URL_, name: ' !! ', company: null },
      'lookup',
      [],
    )
    assertEquals(calls[2]!.body, {
      linkedin_url: URL_,
      kinds: ['email', 'phone'],
    })
    noVendorCalls(calls)
  },
)

// --- the chain goes past an email that fails the check (EMAIL_CHECK_GATES_CHAIN)

onTest(
  'an invalid and a valid email together: both shown as today, each keeps its own check',
  async () => {
    const calls = stubFetch([
      json({
        found_in: 'bettercontact',
        found_in_by_kind: { email: 'bettercontact', phone: 'none' },
        has: { email: true, phone: false },
        emails: [
          {
            value: 'jd@example.com',
            status: 'unknown',
            verified: true,
            check: {
              result: 'valid',
              reason: null,
              checked_at: '2026-11-03T08:00:00.000Z',
            },
          },
          {
            value: 'john.doe@example.com',
            status: 'unknown',
            verified: null,
            check: {
              result: 'invalid',
              reason: 'mailbox_not_found',
              checked_at: '2026-11-03T07:59:00.000Z',
            },
          },
        ],
        phones: [],
      }),
    ])
    const { state, deps } = memory()
    await runViaService(
      deps,
      { linkedinUrl: URL_, name: 'John Doe' },
      'lookup',
      [],
    )
    noVendorCalls(calls)
    assertEquals(state.rows.shared?.emails, [
      { value: 'jd@example.com', type: null, status: 'Valid', check: 'valid' },
      {
        value: 'john.doe@example.com',
        type: null,
        status: null,
        check: 'invalid',
      },
    ])
    assertEquals(state.rows.shared?.email_searched, false)
    assertEquals(state.rows.shared?.phone_searched, true)
    const items = itemsOf('email', state.rows, [])
    assertEquals(
      items.map((x) => [x.value, x.verified, x.invalid, x.feedback]),
      [
        ['jd@example.com', true, false, true],
        ['john.doe@example.com', null, false, true],
      ],
    )
    assertEquals(view(state.rows, [], 'email'), {
      searching: false,
      canFind: false,
      exhausted: false,
      unavailable: false,
    })
    // A later answer that re-checks the second email updates only its own check.
    stubFetch([
      json({
        has: { email: false },
        exhausted: true,
        emails: [
          {
            value: 'John.Doe@example.com',
            status: 'unknown',
            verified: null,
            check: { result: 'unknown', reason: null, checked_at: null },
          },
        ],
      }),
    ])
    state.verdicts = [
      {
        contact_kind: 'email',
        contact_value: 'jd@example.com',
        verdict: 'bad',
        reason: 'bounced',
      },
    ]
    await runViaService(deps, URL_, 'backup', ['email'])
    assertEquals(
      state.rows.shared?.emails.map((e) => [
        e.value,
        (e as { check?: string }).check,
      ]),
      [
        ['jd@example.com', 'valid'],
        ['john.doe@example.com', 'unknown'],
      ],
    )
  },
)
