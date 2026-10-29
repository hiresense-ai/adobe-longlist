// deno test --allow-env supabase/functions/candidate-contacts/contact-store_test.ts
import {
  contactStoreConfigured,
  contactStoreFeedback,
  contactStoreFeedbackLater,
  contactStoreLookup,
  contactStoreSave,
  contactStoreSaveLater,
  contactStoreTimeoutMs,
  ContactStoreUnavailable,
  DEFAULT_TIMEOUT_MS,
  inBackground,
} from './contact-store.ts'
import { storeFirst } from './flow.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

type Call = { url: string; body: Record<string, unknown>; auth: string | null }

function stubFetch(answer: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
      auth: new Headers(init?.headers).get('Authorization'),
    })
    return await answer()
  }) as typeof fetch
  return calls
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function configure(on: boolean) {
  if (on) {
    Deno.env.set('CONTACT_ENRICHMENT_URL', 'http://contact-store.test/')
    Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
  } else {
    Deno.env.delete('CONTACT_ENRICHMENT_URL')
    Deno.env.delete('CONTACT_ENRICHMENT_API_KEY')
  }
}

Deno.test(
  'lookup asks the store (and ZipLabs through it) and keeps only usable values',
  async () => {
    configure(true)
    const calls = stubFetch(() =>
      json({
        emails: [
          { value: 'john@example.com', status: 'good', verified: true },
          { value: 'old@example.com', status: 'bad', verified: false },
        ],
        phones: [{ value: '+15550100', status: 'unknown', verified: null }],
      }),
    )
    const result = await contactStoreLookup(
      'https://www.linkedin.com/in/john-doe/',
    )
    assertEquals(calls[0]!.url, 'http://contact-store.test/v1/contacts/lookup')
    assertEquals(calls[0]!.auth, 'Bearer lyca-test-key')
    assertEquals(calls[0]!.body, {
      linkedin_url: 'https://www.linkedin.com/in/john-doe/',
      kinds: ['email', 'phone'],
    })
    assertEquals(result, {
      status: 'found',
      emails: [{ value: 'john@example.com', type: null, status: 'Valid' }],
      phones: [{ value: '+15550100', type: null, valid: null }],
    })
  },
)

Deno.test(
  'lookup says not_found when nothing is usable, and throws on an outage',
  async () => {
    configure(true)
    stubFetch(() => json({ emails: [], phones: [] }))
    assertEquals(
      (await contactStoreLookup('https://www.linkedin.com/in/john-doe/'))
        .status,
      'not_found',
    )

    stubFetch(() => json({ error: { code: 'ziplabs_unavailable' } }, 503))
    let threw = false
    try {
      await contactStoreLookup('https://www.linkedin.com/in/john-doe/')
    } catch (err) {
      threw =
        err instanceof ContactStoreUnavailable &&
        String(err.message).includes('ziplabs_unavailable')
    }
    assertEquals(threw, true)
  },
)

Deno.test(
  'lookup drops store entries without a string value instead of saving them',
  async () => {
    configure(true)
    stubFetch(() =>
      json({
        emails: [
          { status: 'good', verified: true },
          { value: 7, status: 'unknown', verified: null },
          null,
          { value: '', status: 'unknown', verified: null },
          { value: 'jane.roe@example.com', status: 'unknown', verified: null },
        ],
        phones: [{ value: null, status: 'unknown', verified: null }],
      }),
    )
    const result = await contactStoreLookup(
      'https://www.linkedin.com/in/jane-roe/',
    )
    assertEquals(result, {
      status: 'found',
      emails: [{ value: 'jane.roe@example.com', type: null, status: null }],
      phones: [],
    })
    stubFetch(() => json({ emails: [{ status: 'good' }], phones: 'x' }))
    assertEquals(
      (await contactStoreLookup('https://www.linkedin.com/in/jane-roe/'))
        .status,
      'not_found',
    )
  },
)

Deno.test(
  'save sends vendor values; feedback maps reasons; neither throws',
  async () => {
    configure(true)
    const calls = stubFetch(() => json({}))
    await contactStoreSave('https://www.linkedin.com/in/john-doe/', 'salesql', {
      emails: [{ value: 'john@example.com', type: null, status: 'Valid' }],
      phones: [{ value: '+15550100', type: null, valid: null }],
    })
    assertEquals(calls[0]!.body, {
      linkedin_url: 'https://www.linkedin.com/in/john-doe/',
      contacts: [
        {
          kind: 'email',
          value: 'john@example.com',
          vendor: 'salesql',
          verified: true,
        },
        { kind: 'phone', value: '+15550100', vendor: 'salesql' },
      ],
    })
    await contactStoreFeedback(
      'https://www.linkedin.com/in/john-doe/',
      'phone',
      '+15550100',
      'bad',
      'no_answer',
    )
    assertEquals(calls[1]!.body, {
      linkedin_url: 'https://www.linkedin.com/in/john-doe/',
      kind: 'phone',
      value: '+15550100',
      verdict: 'bad',
      reason: 'not_reachable',
    })

    stubFetch(() => {
      throw new Error('connection refused')
    })
    await contactStoreSave('u', 'salesql', {
      emails: [{ value: 'a@example.com', type: null, status: null }],
      phones: [],
    })
    await contactStoreFeedback('u', 'email', 'a@example.com', 'good', null)
  },
)

Deno.test('nothing is called while unconfigured', async () => {
  configure(false)
  const calls = stubFetch(() => json({}))
  assertEquals(contactStoreConfigured(), false)
  await contactStoreSave('u', 'salesql', {
    emails: [{ value: 'a@example.com', type: null, status: null }],
    phones: [],
  })
  await contactStoreFeedback('u', 'email', 'a@example.com', 'good', null)
  assertEquals(calls.length, 0)
})

// --- Timeout --------------------------------------------------------------

Deno.test(
  'timeout: 8000 ms by default (HIR-528), CONTACT_ENRICHMENT_TIMEOUT_MS overrides',
  () => {
    Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
    assertEquals(DEFAULT_TIMEOUT_MS, 8000)
    assertEquals(contactStoreTimeoutMs(), 8000)
    Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', '1500')
    assertEquals(contactStoreTimeoutMs(), 1500)
    for (const bad of ['', 'abc', '0', '-5']) {
      Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', bad)
      assertEquals(contactStoreTimeoutMs(), 8000)
    }
    Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
  },
)

/** A store that never answers: the request only ends when Lyca aborts it. */
function stubHangingFetch(): Call[] {
  const calls: Call[] = []
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
      auth: new Headers(init?.headers).get('Authorization'),
    })
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason ?? new Error('aborted')),
      )
    })
  }) as typeof fetch
  return calls
}

Deno.test(
  'a slow store: the lookup gives up after CONTACT_ENRICHMENT_TIMEOUT_MS and the vendors run',
  async () => {
    configure(true)
    Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', '50')
    stubHangingFetch()
    const started = Date.now()
    let unavailable = false
    try {
      await contactStoreLookup('https://www.linkedin.com/in/john-doe/')
    } catch (err) {
      unavailable = err instanceof ContactStoreUnavailable
    }
    assertEquals(unavailable, true)
    const r = await storeFirst(
      () => contactStoreLookup('https://www.linkedin.com/in/john-doe/'),
      ['email', 'phone'],
    )
    assertEquals(r, { fromStore: null, missing: ['email', 'phone'] })
    const elapsed = Date.now() - started
    if (elapsed > 2000) throw new Error(`took ${elapsed} ms`)
    Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
  },
)

// --- Saves and 👍/👎 run in the background ---------------------------------

type Runtime = { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }

/** A store that answers only when `release` is called. */
function stubHeldFetch() {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const calls = stubFetch(() => held.then(() => json({})))
  return { calls, release: () => release() }
}

Deno.test(
  'save and feedback are not awaited: handed to EdgeRuntime.waitUntil',
  async () => {
    configure(true)
    const waited: Promise<unknown>[] = []
    ;(globalThis as Runtime).EdgeRuntime = {
      waitUntil: (p) => {
        waited.push(p)
      },
    }
    try {
      const store = stubHeldFetch()
      let settled = false
      const out: unknown = contactStoreSaveLater(
        'https://www.linkedin.com/in/john-doe/',
        'salesql',
        {
          emails: [{ value: 'john@example.com', type: null, status: null }],
          phones: [],
        },
      )
      contactStoreFeedbackLater(
        'https://www.linkedin.com/in/john-doe/',
        'email',
        'john@example.com',
        'bad',
        'bounced',
      )
      // Returned straight away, with the store still not having answered.
      assertEquals(out, undefined)
      assertEquals(waited.length, 2)
      Promise.all(waited).then(() => (settled = true))
      await Promise.resolve()
      assertEquals(settled, false)
      assertEquals(
        store.calls.map((c) => c.url),
        [
          'http://contact-store.test/v1/contacts',
          'http://contact-store.test/v1/contacts/feedback',
        ],
      )
      store.release()
      await Promise.all(waited)
    } finally {
      delete (globalThis as Runtime).EdgeRuntime
    }
  },
)

Deno.test(
  'background calls outside the edge runtime still run, and a failure never throws',
  async () => {
    configure(true)
    delete (globalThis as Runtime).EdgeRuntime
    const calls = stubFetch(() => {
      throw new Error('connection refused')
    })
    contactStoreSaveLater('u', 'bettercontact', {
      emails: [],
      phones: [{ value: '+15550100', type: null, valid: null }],
    })
    contactStoreFeedbackLater('u', 'phone', '+15550100', 'good', null)
    assertEquals(calls.length, 2)
    // A rejected task is caught by inBackground: Deno fails the test on an
    // unhandled rejection, so getting past the next tick proves it.
    inBackground(Promise.reject(new Error('boom')), 'test task')
    await new Promise((r) => setTimeout(r, 0))
  },
)

Deno.test('background calls do nothing while unconfigured', () => {
  configure(false)
  const calls = stubFetch(() => json({}))
  contactStoreSaveLater('u', 'salesql', {
    emails: [{ value: 'a@example.com', type: null, status: null }],
    phones: [],
  })
  contactStoreFeedbackLater('u', 'email', 'a@example.com', 'good', null)
  assertEquals(calls.length, 0)
})
