// deno test --allow-env supabase/functions/candidate-contacts/phone-rule_test.ts
//
// The shared phone rule, exactly contact-enrichment's docs/PHONE.md (its
// src/contacts/contact-value.spec.ts vectors), and BUG-4 of the 3 Nov scenario
// run: a phone the rule refuses (SalesQL "12345" with is_valid true) is never
// kept, shown or counted as found, so BetterContact is asked for a phone.
// Invented people and numbers only.
import { normalizePhone } from './phone.ts'
import {
  kindsMissing,
  kindsToResume,
  kindUnavailable,
  mergeContacts,
  usableValuesOf,
  type PersonRows,
} from './flow.ts'
import { betterContactPoll, salesqlLookup } from './vendors.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

// --- The shared input table (contact-enrichment contact-value.spec.ts) -------

const SHARED_TABLE: Array<[string, string | null]> = [
  // The contract's table.
  ['+91 98765 43210', '+919876543210'],
  ['098765 43210', '+919876543210'],
  ['9876543210', '+919876543210'],
  ['98765-43210', '+919876543210'],
  ['91 9876543210', '+919876543210'],
  ['0091 9876543210', '+919876543210'],
  ['+1 (415) 555-0100', '+14155550100'],
  ['+44 20 7946 0958', '+442079460958'],
  ['12345', null],
  // Not an Indian mobile (first digit 1-5): "+" and the digits.
  ['5550100100', '+5550100100'],
  // Rule 5: no country code starts with 0.
  ['04412345678', null],
  ['+04412345678', null],
  // Rule 6: +91 is a phone only with 12 digits in all.
  ['+91 98765 4321', null],
  ['+91 98765 432100', null],
  // A 10-digit number with no "+" that starts 6-9 is always Indian.
  ['9175550100', '+919175550100'],
  // 12 digits starting 91 but no mobile after it: "+" and the digits.
  ['914412345678', '+914412345678'],
  // Already "+": never rewritten.
  ['+9876543210', '+9876543210'],
  ['  +1 555 0100 ', '+15550100'],
  // 8 and 15 digits are the bounds.
  ['+12345678', '+12345678'],
  ['+123456789012345', '+123456789012345'],
  ['+1234567', null],
  ['+1234567890123456', null],
  ['call me', null],
  ['', null],
  // normalizeContact's phone vectors.
  ['+91 98765-43210', '+919876543210'],
  ['(555) 010.0100', '+5550100100'],
  ['+1 555 0100', '+15550100'],
  ['555-CALL-NOW', null],
  ['+91 +98765', null],
]

Deno.test('phone: the shared input table of docs/PHONE.md, exactly', () => {
  for (const [input, output] of SHARED_TABLE) {
    assertEquals([input, normalizePhone(input)], [input, output])
  }
})

// --- BUG-4 -------------------------------------------------------------------

const KEY = 'linkedin.com/in/john-doe'
const candidate = {
  name: 'John Doe',
  linkedinUrl: 'https://www.linkedin.com/in/john-doe/',
  linkedinKey: KEY,
  company: 'Example Corp',
  title: null,
}

function stubJson(body: unknown) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch
}

Deno.test(
  'BUG-4: SalesQL "12345" (is_valid true) is not kept; the phone is still missing',
  async () => {
    Deno.env.set('SALESQL_API_URL', 'http://fake-salesql.test/v1')
    Deno.env.set('SALESQL_API_KEY', 'fake-key')
    const realFetch = globalThis.fetch
    try {
      stubJson({
        emails: [
          { email: 'john.doe@example.com', type: 'Work', status: 'Valid' },
        ],
        phones: [
          { phone: '12345', type: 'Mobile', is_valid: true },
          { phone: '+91 98765 4321', type: 'Mobile', is_valid: true },
          { phone: '04412345678', type: 'Work', is_valid: true },
        ],
      })
      const found = await salesqlLookup(candidate)
      assertEquals(found.status, 'found')
      assertEquals(found.phones, [])
      assertEquals(kindsMissing(found, ['email', 'phone']), ['phone'])
    } finally {
      globalThis.fetch = realFetch
      Deno.env.delete('SALESQL_API_URL')
      Deno.env.delete('SALESQL_API_KEY')
    }
  },
)

Deno.test(
  'BUG-4: a malformed phone already in a row is never shown or usable, and BetterContact is asked',
  () => {
    const rows: PersonRows = {
      shared: { status: 'not_found', emails: [], phones: [] },
      salesql: {
        status: 'found',
        emails: [
          { value: 'john.doe@example.com', type: 'Work', status: 'Valid' },
        ],
        phones: [{ value: '12345', type: 'Mobile', valid: true }],
      },
    }
    assertEquals(usableValuesOf(rows.salesql, 'phone'), [])
    assertEquals(
      mergeContacts('phone', rows, () => null),
      [],
    )
    // Not "temporarily unavailable" either: nothing failed.
    assertEquals(kindUnavailable(rows, 'phone'), false)
    // SalesQL answered; BetterContact has not been asked for the phone: asked now.
    assertEquals(
      kindsToResume(rows, ['email', 'phone'], {
        salesqlAsked: true,
        salesqlReady: true,
        backupReady: true,
      }),
      ['phone'],
    )
    // A good phone next to it is shown alone.
    rows.salesql!.phones.push({
      value: '+91 98765 43210',
      type: 'Mobile',
      valid: true,
    })
    assertEquals(
      mergeContacts('phone', rows, () => null).map((x) => x.value),
      ['+91 98765 43210'],
    )
  },
)

Deno.test(
  'BUG-4: a BetterContact phone the rule refuses is not kept',
  async () => {
    Deno.env.set('BETTERCONTACT_API_KEY', 'fake-key')
    Deno.env.set('BETTERCONTACT_API_URL', 'http://fake-bettercontact.test')
    const realFetch = globalThis.fetch
    try {
      stubJson({
        status: 'terminated',
        credits_consumed: 1,
        data: [{ contact_phone_number: '+0 4412 345678' }],
      })
      const bad = await betterContactPoll('req-1')
      assertEquals([bad.status, bad.phones], ['not_found', []])
      stubJson({
        status: 'terminated',
        data: [{ contact_phone_number: '+91 98765 43210' }],
      })
      const good = await betterContactPoll('req-2')
      assertEquals(
        good.phones.map((p) => p.value),
        ['+91 98765 43210'],
      )
    } finally {
      globalThis.fetch = realFetch
      Deno.env.delete('BETTERCONTACT_API_KEY')
      Deno.env.delete('BETTERCONTACT_API_URL')
    }
  },
)
