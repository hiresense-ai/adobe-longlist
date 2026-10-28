// deno test --allow-env supabase/functions/candidate-contacts/vendors_test.ts
import {
  BC_DEFAULT_BASE,
  betterContactBase,
  betterContactPoll,
} from './vendors.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

Deno.test(
  'BetterContact base: its own API unless BETTERCONTACT_API_URL is set',
  () => {
    Deno.env.delete('BETTERCONTACT_API_URL')
    assertEquals(betterContactBase(), 'https://app.bettercontact.rocks/api/v2')
    assertEquals(betterContactBase(), BC_DEFAULT_BASE)
    Deno.env.set('BETTERCONTACT_API_URL', '  http://127.0.0.1:4199/api/v2/ ')
    assertEquals(betterContactBase(), 'http://127.0.0.1:4199/api/v2')
    Deno.env.set('BETTERCONTACT_API_URL', '')
    assertEquals(betterContactBase(), BC_DEFAULT_BASE)
    Deno.env.delete('BETTERCONTACT_API_URL')
  },
)

Deno.test(
  'BetterContact calls go to BETTERCONTACT_API_URL when set',
  async () => {
    const realFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = ((input: string | URL) => {
      urls.push(String(input))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'terminated',
            data: [{ contact_email_address: 'jane.roe@example.com' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    try {
      Deno.env.set('BETTERCONTACT_API_KEY', 'fake')
      Deno.env.set('BETTERCONTACT_API_URL', 'http://127.0.0.1:4199/api/v2')
      const result = await betterContactPoll('req-1')
      assertEquals(urls, ['http://127.0.0.1:4199/api/v2/async/req-1'])
      assertEquals([result.status, result.emails.length], ['found', 1])
    } finally {
      globalThis.fetch = realFetch
      Deno.env.delete('BETTERCONTACT_API_KEY')
      Deno.env.delete('BETTERCONTACT_API_URL')
    }
  },
)
