// deno test supabase/functions/candidate-contacts/flow_test.ts
import {
  backupAskedFor,
  canFindAnother,
  contactId,
  kindsMissing,
  kindsToResume,
  mergeContacts,
  originOf,
  sourceOf,
  storeFirst,
  takesFeedback,
  valuesByOrigin,
  type PersonRows,
} from './flow.ts'
import type { VendorResult } from './vendors.ts'

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

// (A 👎 on a SalesQL value — salesqlValues — is covered further down.)
Deno.test('Find another: never after a 👎 on a vendor contact', () => {
  assertEquals(canFindAnother({ ...base, storeValues: new Set() }), false)
})

// Rule changed (HIR-491 follow-up): a 👎 on ANY store value of a kind offers
// "Find another", even while another value of that kind is still unrated.
Deno.test(
  'Find another: offered even while another contact of that kind is left',
  () => {
    assertEquals(
      canFindAnother({
        ...base,
        items: [...base.items, { value: 'jd@example.com', verdict: null }],
      }),
      true,
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

// --- Where a value came from, and 👍/👎 only on store values -------------

const noVerdicts = () => null

Deno.test('source: store values are "store", vendor values "vendor"', () => {
  const rows: PersonRows = {
    shared: {
      emails: [{ value: 'john.doe@example.com', type: null, status: 'Valid' }],
      phones: [],
    },
    // The store had no phone, so SalesQL ran for it and also brought a
    // different email, which is shown too.
    salesql: {
      emails: [{ value: 'jd@example.org', type: 'Work', status: null }],
      phones: [{ value: '+15550100', type: 'Mobile', valid: null }],
    },
  }
  const emails = mergeContacts('email', rows, noVerdicts)
  const phones = mergeContacts('phone', rows, noVerdicts)
  assertEquals(
    emails.map((e) => [e.value, e.source]),
    [
      ['john.doe@example.com', 'store'],
      ['jd@example.org', 'vendor'],
    ],
  )
  assertEquals(
    phones.map((p) => [p.value, p.source]),
    [['+15550100', 'vendor']],
  )
  assertEquals(emails[0]!.verified, true)
})

Deno.test(
  'source: on a later reveal, a store value Lyca already holds from its own vendor counts as vendor',
  () => {
    // The store hides who supplied a value: here it hands back what Lyca's
    // SalesQL / BetterContact found earlier (other case, other phone format).
    const rows: PersonRows = {
      shared: {
        emails: [
          { value: 'John.Doe@Example.com', type: null, status: null },
          { value: 'jane.roe@example.net', type: null, status: null },
        ],
        phones: [{ value: '+15550100', type: null, valid: null }],
      },
      salesql: {
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
      },
      bettercontact: {
        emails: [],
        phones: [{ value: '+1 555-0100', type: 'Mobile', valid: null }],
      },
    }
    assertEquals(
      mergeContacts('email', rows, noVerdicts).map((e) => [e.value, e.source]),
      [
        ['John.Doe@Example.com', 'vendor'],
        ['jane.roe@example.net', 'store'],
      ],
    )
    assertEquals(
      mergeContacts('phone', rows, noVerdicts).map((p) => p.source),
      // HIR-528: one phone format, so the two spellings are one number.
      ['vendor'],
    )
    assertEquals(sourceOf('phone', '+15550100', rows), 'vendor')
    assertEquals(sourceOf('email', 'jane.roe@example.net', rows), 'store')
  },
)

Deno.test('source: with only a store row everything is "store"', () => {
  const rows: PersonRows = {
    shared: {
      emails: [{ value: 'john.doe@example.com', type: null, status: null }],
      phones: [{ value: '+15550100', type: null, valid: true }],
    },
  }
  assertEquals(
    [
      ...mergeContacts('email', rows, noVerdicts),
      ...mergeContacts('phone', rows, noVerdicts),
    ].map((x) => x.source),
    ['store', 'store'],
  )
})

Deno.test('merge carries verdicts and drops duplicates', () => {
  const rows: PersonRows = {
    shared: {
      emails: [{ value: 'john.doe@example.com', type: null, status: null }],
      phones: [],
    },
    salesql: {
      emails: [{ value: 'JOHN.DOE@example.com', type: null, status: null }],
      phones: [],
    },
  }
  const items = mergeContacts('email', rows, (v) =>
    v === 'john.doe@example.com' ? { verdict: 'bad', reason: 'bounced' } : null,
  )
  assertEquals(items.length, 1)
  assertEquals([items[0]!.verdict, items[0]!.reason], ['bad', 'bounced'])
})

// --- Find another after a 👎 on one store value of several ---------------

/** The storeValues set index.ts builds from the merged items. */
function storeValuesOf(
  kind: 'email' | 'phone',
  items: Array<{ value: string; source: string }>,
) {
  return new Set(
    items
      .filter((x) => x.source === 'store')
      .map((x) => contactId(kind, x.value)),
  )
}

Deno.test('Find another: offered after a 👎 on one of two store emails', () => {
  const rows: PersonRows = {
    shared: {
      emails: [
        { value: 'john.doe@example.com', type: null, status: null },
        { value: 'jdoe@example.org', type: null, status: null },
      ],
      phones: [],
    },
  }
  const items = mergeContacts('email', rows, (v) =>
    v === 'john.doe@example.com'
      ? { verdict: 'bad', reason: 'not_reachable' }
      : null,
  )
  assertEquals(
    canFindAnother({
      ...base,
      items,
      storeValues: storeValuesOf('email', items),
    }),
    true,
  )
})

Deno.test(
  'Find another: not offered after a 👎 on one of two store emails when no vendor is left',
  () => {
    const items = [
      { value: 'john.doe@example.com', verdict: 'bad' as const },
      { value: 'jdoe@example.org', verdict: null },
    ]
    const storeValues = new Set(['john.doe@example.com', 'jdoe@example.org'])
    // Both vendors already asked for email.
    assertEquals(
      canFindAnother({
        ...base,
        items,
        storeValues,
        salesqlAsked: true,
        backupAsked: true,
      }),
      false,
    )
    // Neither vendor configured.
    assertEquals(
      canFindAnother({
        ...base,
        items,
        storeValues,
        salesqlReady: false,
        backupReady: false,
      }),
      false,
    )
  },
)

// It does not count as a STORE value; as a SalesQL value it now offers
// BetterContact — see 'Find another: a 👎 on a store-returned value SalesQL
// also found goes to BetterContact' below.
Deno.test(
  'Find another: a 👎 on a store-returned value Lyca holds from its vendor does not count',
  () => {
    const rows: PersonRows = {
      shared: {
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
      },
      salesql: {
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
      },
    }
    const items = mergeContacts('email', rows, () => ({
      verdict: 'bad',
      reason: 'bounced',
    }))
    assertEquals(
      canFindAnother({
        ...base,
        items,
        storeValues: storeValuesOf('email', items),
        salesqlAsked: true,
      }),
      false,
    )
  },
)

// --- Store down / slow / erroring: the vendors run -----------------------

const found = (emails: string[], phones: string[]): VendorResult => ({
  status: 'found',
  emails: emails.map((value) => ({ value, type: null, status: null })),
  phones: phones.map((value) => ({ value, type: null, valid: null })),
})

Deno.test(
  'storeFirst: the store answers, vendors only for what it lacks',
  async () => {
    const r = await storeFirst(
      () => Promise.resolve(found(['john.doe@example.com'], [])),
      ['email', 'phone'],
    )
    assertEquals(r.missing, ['phone'])
    assertEquals(r.fromStore?.emails.length, 1)
  },
)

Deno.test(
  'storeFirst: nothing in the store, vendors for every kind',
  async () => {
    const r = await storeFirst(
      () => Promise.resolve({ status: 'not_found', emails: [], phones: [] }),
      ['email', 'phone'],
    )
    assertEquals(r, { fromStore: null, missing: ['email', 'phone'] })
  },
)

Deno.test(
  'storeFirst: store down, vendors for every kind and no error surfaces',
  async () => {
    const r = await storeFirst(() => {
      throw new Error('connection refused')
    }, ['email', 'phone'])
    assertEquals(r, { fromStore: null, missing: ['email', 'phone'] })
    const r2 = await storeFirst(
      () => Promise.reject(new Error('HTTP 503')),
      ['email', 'phone'],
    )
    assertEquals(r2, { fromStore: null, missing: ['email', 'phone'] })
  },
)

// --- Two backup vendors: SalesQL first, BetterContact last ---------------

const email = (value: string) => ({ value, type: null, status: null })
const phone = (value: string) => ({ value, type: null, valid: null })

Deno.test('origin: store, salesql or bettercontact (SalesQL first)', () => {
  const rows: PersonRows = {
    shared: {
      emails: [email('john.doe@example.com'), email('jd@example.org')],
      phones: [],
    },
    salesql: { emails: [email('JD@example.org')], phones: [] },
    bettercontact: {
      emails: [email('jd@example.org'), email('j.doe@example.net')],
      phones: [],
      email_searched: true,
    },
  }
  assertEquals(originOf('email', 'john.doe@example.com', rows), 'store')
  assertEquals(originOf('email', 'jd@example.org', rows), 'salesql')
  assertEquals(originOf('email', 'j.doe@example.net', rows), 'bettercontact')
  // The dashboard is only told store / vendor.
  assertEquals(sourceOf('email', 'j.doe@example.net', rows), 'vendor')
})

Deno.test(
  'thumbs: store and SalesQL values while BetterContact is not yet asked; never BetterContact values',
  () => {
    const rows: PersonRows = {
      shared: { emails: [email('john.doe@example.com')], phones: [] },
      salesql: {
        emails: [email('jd@example.org')],
        phones: [phone('+15550100')],
      },
      // BetterContact ran for the phone only.
      bettercontact: {
        emails: [],
        phones: [phone('+15550199')],
        phone_searched: true,
      },
    }
    const emails = mergeContacts('email', rows, noVerdicts)
    const phones = mergeContacts('phone', rows, noVerdicts)
    assertEquals(
      emails.map((e) => [e.value, e.source, e.feedback]),
      [
        ['john.doe@example.com', 'store', true],
        ['jd@example.org', 'vendor', true],
      ],
    )
    // BetterContact was asked for phones: the SalesQL phone loses its thumbs,
    // the BetterContact phone never had them.
    assertEquals(
      phones.map((p) => [p.value, p.source, p.feedback]),
      [
        ['+15550100', 'vendor', false],
        ['+15550199', 'vendor', false],
      ],
    )
    assertEquals(takesFeedback('email', 'jd@example.org', rows), true)
    assertEquals(takesFeedback('phone', '+15550199', rows), false)
  },
)

Deno.test(
  'thumbs: a SalesQL value loses them once BetterContact answered or is searching for that kind',
  () => {
    const salesql = { emails: [email('jd@example.org')], phones: [] }
    const searched: PersonRows = {
      salesql,
      bettercontact: { emails: [], phones: [], email_searched: true },
    }
    assertEquals(takesFeedback('email', 'jd@example.org', searched), false)
    const pending: PersonRows = {
      salesql,
      bettercontact: {
        emails: [],
        phones: [],
        status: 'pending',
        pending_kinds: ['email'],
      },
    }
    assertEquals(backupAskedFor('email', pending), true)
    assertEquals(backupAskedFor('phone', pending), false)
    assertEquals(takesFeedback('email', 'jd@example.org', pending), false)
    // A BetterContact error is not an answer: the SalesQL value keeps them.
    const errored: PersonRows = {
      salesql,
      bettercontact: { emails: [], phones: [], status: 'error' },
    }
    assertEquals(takesFeedback('email', 'jd@example.org', errored), true)
  },
)

Deno.test(
  'Find another: after a thumbs-down on a SalesQL value, BetterContact if not yet asked for that kind',
  () => {
    const items = [{ value: 'jd@example.org', verdict: 'bad' as const }]
    const input = {
      ...base,
      items,
      storeValues: new Set<string>(),
      salesqlValues: new Set(['jd@example.org']),
      salesqlAsked: true,
    }
    assertEquals(canFindAnother(input), true)
    assertEquals(canFindAnother({ ...input, backupAsked: true }), false)
    assertEquals(canFindAnother({ ...input, backupReady: false }), false)
  },
)

Deno.test(
  'Find another: never after a thumbs-down on a BetterContact value',
  () => {
    const rows: PersonRows = {
      salesql: { emails: [email('jd@example.org')], phones: [] },
      bettercontact: {
        emails: [email('j.doe@example.net')],
        phones: [],
        email_searched: true,
      },
    }
    const items = mergeContacts('email', rows, (v) =>
      v === 'j.doe@example.net'
        ? { verdict: 'bad', reason: 'not_reachable' }
        : null,
    )
    const { storeValues, salesqlValues } = valuesByOrigin('email', items, rows)
    for (const backupAsked of [true, false]) {
      assertEquals(
        canFindAnother({
          ...base,
          items,
          storeValues,
          salesqlValues,
          salesqlAsked: true,
          backupAsked,
        }),
        false,
      )
    }
  },
)

Deno.test(
  'Find another: after a thumbs-down on a store value, SalesQL first, else BetterContact',
  () => {
    // SalesQL never asked: offered even without BetterContact.
    assertEquals(canFindAnother({ ...base, backupReady: false }), true)
    // SalesQL already asked: BetterContact is next.
    assertEquals(canFindAnother({ ...base, salesqlAsked: true }), true)
    assertEquals(
      canFindAnother({ ...base, salesqlAsked: true, backupAsked: true }),
      false,
    )
  },
)

Deno.test(
  'Find another: a 👎 on a store-returned value SalesQL also found goes to BetterContact',
  () => {
    const rows: PersonRows = {
      shared: { emails: [email('john.doe@example.com')], phones: [] },
      salesql: { emails: [email('john.doe@example.com')], phones: [] },
    }
    const items = mergeContacts('email', rows, () => ({
      verdict: 'bad',
      reason: 'bounced',
    }))
    const { storeValues, salesqlValues } = valuesByOrigin('email', items, rows)
    assertEquals([...storeValues], [])
    assertEquals([...salesqlValues], ['john.doe@example.com'])
    assertEquals(
      canFindAnother({
        ...base,
        items,
        storeValues,
        salesqlValues,
        salesqlAsked: true,
      }),
      true,
    )
  },
)

// --- Malformed stored values are dropped, never crash the panel ----------

Deno.test('merge drops stored values without a string value', () => {
  const rows = {
    shared: {
      emails: [
        { type: null, status: null },
        { value: 42, type: null, status: null },
        null,
        { value: '  ', type: null, status: null },
        email('john.doe@example.com'),
      ],
      phones: [{ value: null, type: null, valid: null }],
    },
    salesql: { emails: [{ value: undefined }], phones: null },
  } as unknown as PersonRows
  assertEquals(
    mergeContacts('email', rows, noVerdicts).map((e) => e.value),
    ['john.doe@example.com'],
  )
  assertEquals(mergeContacts('phone', rows, noVerdicts), [])
  assertEquals(kindsMissing(rows.shared!, ['email', 'phone']), ['phone'])
  assertEquals(sourceOf('email', 'john.doe@example.com', rows), 'store')
})

// --- "Get contact" on a person looked up before: resume, never re-buy -----

const ready = { salesqlAsked: true, salesqlReady: true, backupReady: true }

Deno.test(
  'resume: an older SalesQL row with only an email resumes the phone (BetterContact never asked)',
  () => {
    const rows: PersonRows = {
      salesql: { emails: [email('jd@example.org')], phones: [] },
    }
    assertEquals(kindsToResume(rows, ['email', 'phone'], ready), ['phone'])
  },
)

Deno.test('resume: nothing once every vendor answered for the kind', () => {
  const rows: PersonRows = {
    salesql: { emails: [email('jd@example.org')], phones: [] },
    bettercontact: {
      emails: [],
      phones: [],
      status: 'not_found',
      phone_searched: true,
    },
  }
  assertEquals(kindsToResume(rows, ['email', 'phone'], ready), [])
})

Deno.test('resume: a BetterContact error is searched again', () => {
  const rows: PersonRows = {
    salesql: { emails: [email('jd@example.org')], phones: [], status: 'found' },
    bettercontact: {
      emails: [],
      phones: [],
      status: 'error',
      phone_searched: false,
    },
  }
  assertEquals(kindsToResume(rows, ['email', 'phone'], ready), ['phone'])
})

Deno.test(
  'resume: a store email with a SalesQL error resumes the phone through SalesQL',
  () => {
    const rows: PersonRows = {
      shared: { emails: [email('john.doe@example.com')], phones: [] },
      salesql: { emails: [], phones: [], status: 'error' },
    }
    assertEquals(
      kindsToResume(rows, ['email', 'phone'], {
        salesqlAsked: false,
        salesqlReady: true,
        backupReady: false,
      }),
      ['phone'],
    )
  },
)

Deno.test(
  'resume: a kind with values is left to Find another; nothing when no vendor is configured',
  () => {
    const rows: PersonRows = {
      shared: { emails: [email('john.doe@example.com')], phones: [] },
    }
    assertEquals(
      kindsToResume(rows, ['email', 'phone'], {
        salesqlAsked: false,
        salesqlReady: true,
        backupReady: true,
      }),
      ['phone'],
    )
    assertEquals(
      kindsToResume(rows, ['email', 'phone'], {
        salesqlAsked: false,
        salesqlReady: false,
        backupReady: false,
      }),
      [],
    )
  },
)
