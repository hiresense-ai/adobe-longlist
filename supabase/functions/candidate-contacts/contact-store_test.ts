// deno test --allow-env supabase/functions/candidate-contacts/contact-store_test.ts
import {
  contactStoreConfigured,
  contactStoreFeedback,
  contactStoreLookup,
  contactStoreSave,
  ContactStoreUnavailable,
} from './contact-store.ts'

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
