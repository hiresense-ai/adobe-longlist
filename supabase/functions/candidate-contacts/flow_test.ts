// deno test supabase/functions/candidate-contacts/flow_test.ts
import { canFindAnother, kindsMissing } from './flow.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const base = {
  kind: 'email' as const,
  items: [{ value: 'john.doe@example.com', verdict: 'bad' as const }],
  storeValues: new Set(['john.doe@example.com']),
  salesqlAsked: false,
  backupAsked: false,
  salesqlReady: true,
  backupReady: true,
}

Deno.test('kindsMissing: the kinds the store had nothing for', () => {
  assertEquals(
    kindsMissing({ emails: [{ value: 'a@example.com' }], phones: [] }, [
      'email',
      'phone',
    ]),
    ['phone'],
  )
  assertEquals(kindsMissing(null, ['email', 'phone']), ['email', 'phone'])
  assertEquals(
    kindsMissing(
      {
        emails: [{ value: 'a@example.com' }],
        phones: [{ value: '+910000000000' }],
      },
      ['email', 'phone'],
    ),
    [],
  )
})

Deno.test('Find another: offered after a 👎 on a store contact', () => {
  assertEquals(canFindAnother(base), true)
})

Deno.test('Find another: matches the store value regardless of case', () => {
  assertEquals(
    canFindAnother({
      ...base,
      items: [{ value: 'John.Doe@Example.com', verdict: 'bad' }],
    }),
    true,
  )
})

Deno.test('Find another: never after a 👎 on a vendor contact', () => {
  assertEquals(canFindAnother({ ...base, storeValues: new Set() }), false)
})

Deno.test(
  'Find another: not while a usable contact of that kind is left',
  () => {
    assertEquals(
      canFindAnother({
        ...base,
        items: [...base.items, { value: 'jd@example.com', verdict: null }],
      }),
      false,
    )
  },
)

Deno.test('Find another: not without a 👎', () => {
  assertEquals(
    canFindAnother({
      ...base,
      items: [{ value: 'john.doe@example.com', verdict: null }],
    }),
    false,
  )
})

Deno.test('Find another: not once every vendor was asked', () => {
  assertEquals(
    canFindAnother({ ...base, salesqlAsked: true, backupAsked: true }),
    false,
  )
  assertEquals(
    canFindAnother({ ...base, salesqlAsked: true, backupReady: false }),
    false,
  )
  assertEquals(canFindAnother({ ...base, salesqlAsked: true }), true)
})
