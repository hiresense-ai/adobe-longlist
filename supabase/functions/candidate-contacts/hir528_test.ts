// deno test --allow-env supabase/functions/candidate-contacts/hir528_test.ts
//
// HIR-528: one phone format, invalid vendor values, the store's `pending`,
// the store asked first, outages vs "not found", and one paid call per person
// and vendor at a time. Invented people and numbers only.
import { normalizePhone } from './phone.ts'
import {
  contactId,
  isInvalid,
  kindsForStore,
  kindsMissing,
  kindsToResume,
  kindUnavailable,
  mergeContacts,
  PENDING_WAIT_MAX_MS,
  sameContact,
  storeAsked,
  storeFirst,
  storeRowAfterAsk,
  STORE_UNREACHABLE,
  type PersonRows,
  type StoreAnswer,
} from './flow.ts'
import {
  BACKGROUND_TIMEOUT_MS,
  contactStoreLookup,
  contactStoreSave,
  ContactStoreUnavailable,
  isRateLimited,
  logStoreFailure,
  storeContactsFrom,
} from './contact-store.ts'
import { onceAtATime, type ClaimStore } from './claims.ts'
import {
  betterContactOnce,
  PaidAnswerNotSaved,
  salesqlOnce,
  type BackupState,
} from './paid.ts'
import { Deadline, VENDOR_CALL_NEEDS_MS } from './deadline.ts'
import {
  salesqlBase,
  salesqlLookup,
  SALESQL_DEFAULT_BASE,
  SALESQL_TIMED_OUT,
  type ContactKind,
  type VendorResult,
} from './vendors.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const noVerdicts = () => null

// --- 1. Phone format: the shared contract's table ---------------------------

const CONTRACT: Array<[string, string | null]> = [
  ['+91 98765 43210', '+919876543210'],
  ['098765 43210', '+919876543210'],
  ['9876543210', '+919876543210'],
  ['98765-43210', '+919876543210'],
  ['91 9876543210', '+919876543210'],
  ['0091 9876543210', '+919876543210'],
  ['+1 (415) 555-0100', '+14155550100'],
  ['+44 20 7946 0958', '+442079460958'],
  ['12345', null],
]

Deno.test('phone: the shared contract table, exactly', () => {
  for (const [input, output] of CONTRACT) {
    assertEquals([input, normalizePhone(input)], [input, output])
  }
})

Deno.test(
  'phone: the rule edges (8–15 digits, 00, non-mobile 10 digits)',
  () => {
    assertEquals(normalizePhone('+1234567'), null) // 7 digits
    assertEquals(normalizePhone('+12345678'), '+12345678') // 8
    assertEquals(normalizePhone('+1234567890123456'), null) // 16
    assertEquals(normalizePhone('0044 20 7946 0958'), '+442079460958')
    assertEquals(normalizePhone('1234567890'), '+1234567890') // 10 digits, not 6–9
    assertEquals(normalizePhone(''), null)
    assertEquals(normalizePhone(null), null)
  },
)

Deno.test('phone: every comparison uses the shared format', () => {
  const spellings = CONTRACT.filter(([, out]) => out === '+919876543210').map(
    ([input]) => input,
  )
  for (const a of spellings) {
    for (const b of spellings) assertEquals(sameContact('phone', a, b), true)
  }
  assertEquals(sameContact('phone', '+91 98765 43210', '+14155550100'), false)
  assertEquals(contactId('phone', '098765 43210'), '+919876543210')
  // Not a phone: compared as stored.
  assertEquals(contactId('phone', ' 12345 '), '12345')
  assertEquals(
    sameContact('email', ' John.Doe@Example.com', 'john.doe@example.com'),
    true,
  )
})

Deno.test(
  'phone: one number in three spellings is one value; a 👎 on one spelling holds for all',
  () => {
    const phone = (value: string) => ({ value, type: null, valid: null })
    const rows: PersonRows = {
      shared: { emails: [], phones: [phone('+91 98765 43210')] },
      salesql: { emails: [], phones: [phone('9876543210')] },
      bettercontact: { emails: [], phones: [phone('098765 43210')] },
    }
    const marked = (v: string) =>
      sameContact('phone', v, '9876543210')
        ? { verdict: 'bad' as const, reason: 'no_answer' }
        : null
    const items = mergeContacts('phone', rows, marked)
    assertEquals(items.length, 1)
    assertEquals(items[0]!.verdict, 'bad')
  },
)

// --- 5. Invalid vendor values are not "found" -------------------------------

Deno.test(
  'invalid: SalesQL "Invalid" emails and is_valid:false phones do not count as found',
  () => {
    assertEquals(isInvalid('email', { status: 'Invalid' }), true)
    assertEquals(isInvalid('email', { status: 'undeliverable' }), true)
    assertEquals(isInvalid('email', { status: 'Valid' }), false)
    assertEquals(isInvalid('phone', { valid: false }), true)
    assertEquals(isInvalid('phone', { valid: null }), false)
    const salesql = {
      status: 'found' as const,
      emails: [
        { value: 'old.job@example.com', type: 'Work', status: 'Invalid' },
      ],
      phones: [{ value: '+15550100', type: null, valid: false }],
    }
    // So BetterContact runs for both kinds.
    assertEquals(kindsMissing(salesql, ['email', 'phone']), ['email', 'phone'])
    // A person whose SalesQL answer holds only invalid values is resumed.
    assertEquals(
      kindsToResume({ salesql }, ['email', 'phone'], {
        salesqlAsked: true,
        salesqlReady: true,
        backupReady: true,
      }),
      ['email', 'phone'],
    )
  },
)

Deno.test(
  'invalid: shown flagged while nothing better exists, hidden once a usable one does',
  () => {
    const onlyInvalid: PersonRows = {
      salesql: {
        emails: [
          { value: 'old.job@example.com', type: 'Work', status: 'Invalid' },
        ],
        phones: [],
      },
    }
    const shown = mergeContacts('email', onlyInvalid, noVerdicts)
    assertEquals(
      shown.map((x) => [x.value, x.invalid, x.verified]),
      [['old.job@example.com', true, false]],
    )
    const withGood: PersonRows = {
      ...onlyInvalid,
      bettercontact: {
        emails: [
          { value: 'john.doe@example.com', type: null, status: 'deliverable' },
        ],
        phones: [],
      },
    }
    assertEquals(
      mergeContacts('email', withGood, noVerdicts).map((x) => x.value),
      ['john.doe@example.com'],
    )
  },
)

// --- 4 / 6. The store asked first; outage is not "not found" ------------------

Deno.test(
  'store asked: no contact_store row or an error row means it was not',
  () => {
    const none: PersonRows = {
      salesql: { emails: [], phones: [], status: 'not_found' },
    }
    assertEquals(storeAsked(none), false)
    assertEquals(kindsForStore(none, ['email', 'phone'], true), [
      'email',
      'phone',
    ])
    assertEquals(kindsForStore(none, ['email', 'phone'], false), [])
    const down: PersonRows = {
      ...none,
      shared: { emails: [], phones: [], status: 'error' },
    }
    assertEquals(kindsForStore(down, ['email', 'phone'], true), [
      'email',
      'phone',
    ])
    const asked: PersonRows = {
      ...none,
      shared: { emails: [], phones: [], status: 'not_found' },
    }
    assertEquals(kindsForStore(asked, ['email', 'phone'], true), [])
    // A kind with a usable value is never sent back to the store.
    const half: PersonRows = {
      salesql: {
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
        status: 'found',
      },
    }
    assertEquals(kindsForStore(half, ['email', 'phone'], true), ['phone'])
  },
)

Deno.test(
  'outage: nothing usable while a source failed is "unavailable", not "not found"',
  () => {
    const storeDown: PersonRows = {
      shared: { emails: [], phones: [], status: 'error' },
      salesql: { emails: [], phones: [], status: 'not_found' },
    }
    assertEquals(kindUnavailable(storeDown, 'email'), true)
    const vendorDown: PersonRows = {
      shared: { emails: [], phones: [], status: 'not_found' },
      salesql: { emails: [], phones: [], status: 'error' },
    }
    assertEquals(kindUnavailable(vendorDown, 'phone'), true)
    const answered: PersonRows = {
      shared: { emails: [], phones: [], status: 'not_found' },
      salesql: { emails: [], phones: [], status: 'not_found' },
    }
    assertEquals(kindUnavailable(answered, 'email'), false)
    const found: PersonRows = {
      ...storeDown,
      salesql: {
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        phones: [],
        status: 'found',
      },
    }
    assertEquals(kindUnavailable(found, 'email'), false)
    assertEquals(kindUnavailable(found, 'phone'), true)
  },
)

// --- 2. The store's `pending` --------------------------------------------------

const answer = (over: Partial<StoreAnswer> = {}): StoreAnswer => ({
  status: 'not_found',
  emails: [],
  phones: [],
  ...over,
})

Deno.test(
  'pending: wait retry_after_ms, ask once more, then vendors only for what is still missing',
  async () => {
    const waits: number[] = []
    const answers = [
      answer({ pending: ['email', 'phone'], retryAfterMs: 1500 }),
      answer({
        status: 'found',
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
      }),
    ]
    let asked = 0
    const r = await storeFirst(
      () => Promise.resolve(answers[asked++]!),
      ['email', 'phone'],
      {
        sleep: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      },
    )
    assertEquals(asked, 2)
    assertEquals(waits, [1500])
    // The email came; the phone is still pending or missing: the vendors get it.
    assertEquals(r.missing, ['phone'])
  },
)

Deno.test(
  'pending: the wait is capped at 5 s and the store is asked again only once',
  async () => {
    const waits: number[] = []
    let asked = 0
    const r = await storeFirst(
      () => {
        asked++
        return Promise.resolve(
          answer({ pending: ['email'], retryAfterMs: 60_000 }),
        )
      },
      ['email', 'phone'],
      { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    )
    assertEquals(asked, 2)
    assertEquals(waits, [PENDING_WAIT_MAX_MS])
    assertEquals(r, { fromStore: null, missing: ['email', 'phone'] })
  },
)

Deno.test(
  'pending: no pending (or an older store) means no wait; a failed re-ask keeps the first answer',
  async () => {
    let slept = false
    const sleep = () => ((slept = true), Promise.resolve())
    const r = await storeFirst(() => Promise.resolve(answer()), ['email'], {
      sleep,
    })
    assertEquals([slept, r.missing], [false, ['email']])

    let asked = 0
    const first = answer({
      status: 'found',
      emails: [{ value: 'john.doe@example.com', type: null, status: null }],
      pending: ['phone'],
      retryAfterMs: 10,
    })
    const kept = await storeFirst(
      () =>
        asked++ === 0
          ? Promise.resolve(first)
          : Promise.reject(new Error('down')),
      ['email', 'phone'],
      { sleep: () => Promise.resolve() },
    )
    assertEquals(kept.missing, ['phone'])
    assertEquals(kept.fromStore?.emails.length, 1)
  },
)

Deno.test(
  "pending: the store's answer is read; an outage is reported to the caller",
  async () => {
    Deno.env.set('CONTACT_ENRICHMENT_URL', 'http://contact-store.test')
    Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
    const bodies: unknown[] = []
    globalThis.fetch = ((_: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            emails: [],
            phones: [],
            pending: ['phone'],
            retry_after_ms: 1500,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    const r = await contactStoreLookup(
      'https://www.linkedin.com/in/john-doe/',
      ['phone'],
    )
    assertEquals(bodies[0], {
      linkedin_url: 'https://www.linkedin.com/in/john-doe/',
      kinds: ['phone'],
    })
    assertEquals(
      [r.status, r.pending, r.retryAfterMs],
      ['not_found', ['phone'], 1500],
    )

    let reported = 0
    const saved = console.warn
    console.warn = () => {}
    try {
      await storeFirst(
        () => Promise.reject(new ContactStoreUnavailable('HTTP 503', 503)),
        ['email'],
        {
          onUnavailable: () => reported++,
        },
      )
    } finally {
      console.warn = saved
    }
    assertEquals(reported, 1)
  },
)

Deno.test(
  'timeouts: the reveal waits 8 s by default; background saves give up after their own 3 s',
  async () => {
    assertEquals(BACKGROUND_TIMEOUT_MS, 3000)
    Deno.env.set('CONTACT_ENRICHMENT_URL', 'http://contact-store.test')
    Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
    Deno.env.set('CONTACT_ENRICHMENT_TIMEOUT_MS', '60000')
    globalThis.fetch = ((_: string | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        ),
      )) as typeof fetch
    const saved = console.warn
    console.warn = () => {}
    const started = Date.now()
    try {
      const ok = await contactStoreSave(
        'https://www.linkedin.com/in/john-doe/',
        'salesql',
        {
          emails: [{ value: 'john.doe@example.com', type: null, status: null }],
          phones: [],
        },
      )
      assertEquals(ok, false)
    } finally {
      console.warn = saved
      Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
    }
    const took = Date.now() - started
    if (took < 2_500 || took > 6_000)
      throw new Error(`background save took ${took} ms`)
  },
)

// --- 7. A refused key is an error, not a warning -------------------------------

Deno.test(
  'logs: a store 401/403 is logged as an error, other failures as warnings',
  () => {
    const errors: string[] = []
    const warns: string[] = []
    const saved = { error: console.error, warn: console.warn }
    console.error = (m: string) => errors.push(m)
    console.warn = (m: string) => warns.push(m)
    try {
      logStoreFailure(
        'contact store save skipped',
        new ContactStoreUnavailable('HTTP 401', 401),
      )
      logStoreFailure(
        'contact store save skipped',
        new ContactStoreUnavailable('HTTP 403', 403),
      )
      logStoreFailure(
        'contact store save skipped',
        new ContactStoreUnavailable('HTTP 503', 503),
      )
    } finally {
      Object.assign(console, saved)
    }
    assertEquals(errors.length, 2)
    if (!errors[0]!.includes('CONTACT_ENRICHMENT_API_KEY'))
      throw new Error(errors[0])
    assertEquals(warns, ['contact store save skipped: HTTP 503'])
  },
)

// --- 1. One paid call per person and vendor at a time ------------------------

/** candidate_contact_claims in memory, with the same rules as claims-db.ts. */
function memoryClaims(): ClaimStore & {
  rows: Map<string, { id: string; at: string }>
} {
  const rows = new Map<string, { id: string; at: string }>()
  const k = (key: string, vendor: string) => `${key}|${vendor}`
  return {
    rows,
    tryClaim(key, vendor, claimId, staleBefore) {
      const row = rows.get(k(key, vendor))
      if (row && row.at < staleBefore) rows.delete(k(key, vendor))
      if (rows.has(k(key, vendor))) return Promise.resolve(false)
      rows.set(k(key, vendor), { id: claimId, at: new Date().toISOString() })
      return Promise.resolve(true)
    },
    held(key, vendor, staleBefore) {
      const row = rows.get(k(key, vendor))
      return Promise.resolve(!!row && row.at >= staleBefore)
    },
    release(key, vendor, claimId) {
      if (rows.get(k(key, vendor))?.id === claimId) rows.delete(k(key, vendor))
      return Promise.resolve()
    },
    refresh(key, vendor, claimId) {
      const row = rows.get(k(key, vendor))
      if (row?.id !== claimId) return Promise.resolve(false)
      row.at = new Date().toISOString()
      return Promise.resolve(true)
    },
  }
}

const KEY = 'linkedin.com/in/john-doe'
const fast = { pollMs: 5, waitMs: 2_000 }

Deno.test(
  'claims: two reveals of one person at once pay the vendor once; the other waits for it',
  async () => {
    const claims = memoryClaims()
    let paid = 0
    const pay = async () => {
      paid++
      await new Promise((r) => setTimeout(r, 50))
      return 'answer'
    }
    const [a, b] = await Promise.all([
      onceAtATime(claims, KEY, 'salesql', pay, fast),
      onceAtATime(claims, KEY, 'salesql', pay, fast),
    ])
    assertEquals(paid, 1)
    assertEquals([a.ran, b.ran].sort(), [false, true])
    const loser = a.ran ? b : a
    assertEquals(loser, { ran: false, settled: true })
    assertEquals(claims.rows.size, 0) // released
    // Another vendor, or another person, is not blocked.
    const other = await onceAtATime(
      claims,
      'linkedin.com/in/jane-roe',
      'salesql',
      pay,
      fast,
    )
    assertEquals(other.ran, true)
  },
)

Deno.test(
  'claims: released when the vendor call throws; a crashed claim is taken over when stale',
  async () => {
    const claims = memoryClaims()
    let threw = false
    try {
      await onceAtATime(
        claims,
        KEY,
        'bettercontact',
        () => Promise.reject(new Error('vendor down')),
        fast,
      )
    } catch {
      threw = true
    }
    assertEquals([threw, claims.rows.size], [true, 0])

    // A claim left 10 minutes ago by a request that died.
    claims.rows.set(`${KEY}|bettercontact`, {
      id: 'dead',
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    let paid = 0
    const r = await onceAtATime(
      claims,
      KEY,
      'bettercontact',
      () => Promise.resolve(++paid),
      fast,
    )
    assertEquals([r.ran, paid], [true, 1])
  },
)

Deno.test(
  'claims: a loser that waits past the limit pays nothing',
  async () => {
    const claims = memoryClaims()
    claims.rows.set(`${KEY}|salesql`, {
      id: 'busy',
      at: new Date().toISOString(),
    })
    let paid = 0
    const r = await onceAtATime(
      claims,
      KEY,
      'salesql',
      () => Promise.resolve(++paid),
      {
        pollMs: 5,
        waitMs: 30,
      },
    )
    assertEquals([r, paid], [{ ran: false, settled: false }, 0])
  },
)

// --- HIR-528 review: a paid answer is never lost, claims stay fresh ----------

const ANSWER: VendorResult = {
  status: 'found',
  emails: [{ value: 'john.doe@example.com', type: 'Work', status: 'Valid' }],
  phones: [{ value: '+15550100001', type: 'Mobile', valid: true }],
}
const noSleep = () => Promise.resolve()

/** Runs `fn` with console.warn / console.error captured. */
async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | null; thrown: unknown; logs: string[] }> {
  const saved = { warn: console.warn, error: console.error }
  const logs: string[] = []
  console.warn = (...a: unknown[]) => logs.push(a.join(' '))
  console.error = (...a: unknown[]) => logs.push(a.join(' '))
  try {
    return { value: await fn(), thrown: null, logs }
  } catch (err) {
    return { value: null, thrown: err, logs }
  } finally {
    Object.assign(console, saved)
  }
}

function assertNoContactData(lines: string[]) {
  for (const line of lines) {
    if (/@|\+1555|john|linkedin/i.test(line)) {
      throw new Error(`contact data in a log line: ${line}`)
    }
  }
}

Deno.test(
  'paid answer: a failed save is retried once with the same answer; the vendor is paid once',
  async () => {
    const claims = memoryClaims()
    let paid = 0
    let failures = 1
    let saved: VendorResult | null = null
    const { value, logs } = await captureLogs(() =>
      salesqlOnce({
        claims,
        key: KEY,
        readSaved: () => Promise.resolve(saved),
        lookup: () => {
          paid++
          return Promise.resolve(ANSWER)
        },
        save: (result) => {
          if (failures-- > 0) return Promise.reject({ code: '57014' })
          saved = result
          return Promise.resolve()
        },
        options: fast,
        sleep: noSleep,
      }),
    )
    assertEquals(paid, 1)
    assertEquals(saved, ANSWER)
    assertEquals(value, { ran: true, value: ANSWER })
    assertEquals(claims.rows.size, 0) // released after the saved retry
    assertNoContactData(logs)
  },
)

Deno.test(
  'paid answer: two failed saves keep the claim, log the counts only, and the next reveal pays nothing',
  async () => {
    const claims = memoryClaims()
    let paid = 0
    const deps = {
      claims,
      key: KEY,
      readSaved: () => Promise.resolve(null),
      lookup: () => {
        paid++
        return Promise.resolve(ANSWER)
      },
      save: () => Promise.reject({ code: '08006' }),
      sleep: noSleep,
    }
    const first = await captureLogs(() =>
      salesqlOnce({ ...deps, options: fast }),
    )
    if (!(first.thrown instanceof PaidAnswerNotSaved)) {
      throw new Error(`expected PaidAnswerNotSaved, got ${first.thrown}`)
    }
    assertEquals(paid, 1)
    assertEquals(claims.rows.size, 1) // kept: nobody pays again until it goes stale
    const lost = first.logs.find((l) => l.includes('NOT saved'))
    if (!lost?.includes('status found, 1 email(s), 1 phone(s)')) {
      throw new Error(`no counts in: ${first.logs.join(' | ')}`)
    }
    if (!lost.includes('08006')) throw new Error(lost)
    assertNoContactData(first.logs)

    // A second click a moment later waits for the kept claim and pays nothing.
    const second = await salesqlOnce({
      ...deps,
      options: { pollMs: 5, waitMs: 30 },
    })
    assertEquals([second, paid], [{ ran: false, settled: false }, 1])
  },
)

Deno.test(
  'claims: a winner slower than the stale time refreshes its claim and is never taken over',
  async () => {
    const claims = memoryClaims()
    let paid = 0
    const slow = async () => {
      paid++
      await new Promise((r) => setTimeout(r, 300))
      return 'answer'
    }
    const options = { staleMs: 100, refreshMs: 20, pollMs: 5, waitMs: 1_000 }
    const winner = onceAtATime(claims, KEY, 'bettercontact', slow, options)
    await new Promise((r) => setTimeout(r, 150)) // past staleMs: only the refresh keeps it
    const other = await onceAtATime(claims, KEY, 'bettercontact', slow, options)
    assertEquals((await winner).ran, true)
    assertEquals([other, paid], [{ ran: false, settled: true }, 1])
    assertEquals(claims.rows.size, 0)
  },
)

Deno.test(
  'BetterContact once: kinds searched meanwhile, or a search still running, are not bought again',
  async () => {
    const claims = memoryClaims()
    const asked: ContactKind[][] = []
    const saves: ContactKind[][] = []
    const run = (saved: BackupState | null) =>
      betterContactOnce({
        claims,
        key: KEY,
        wanted: ['email', 'phone'],
        readSaved: () => Promise.resolve(saved),
        lookup: (kinds) => {
          asked.push(kinds)
          return Promise.resolve(ANSWER)
        },
        save: (_row, kinds) => {
          saves.push(kinds)
          return Promise.resolve()
        },
        options: fast,
        sleep: noSleep,
      })
    const searchedEmail = {
      status: 'found',
      email_searched: true,
      phone_searched: false,
    }
    assertEquals(await run(searchedEmail), { ran: true, value: true })
    assertEquals(asked, [['phone']])
    assertEquals(saves, [['phone']])
    const pending = {
      status: 'pending',
      email_searched: false,
      phone_searched: false,
    }
    assertEquals(await run(pending), { ran: true, value: false })
    const both = { status: 'found', email_searched: true, phone_searched: true }
    assertEquals(await run(both), { ran: true, value: false })
    assertEquals(asked.length, 1)
  },
)

Deno.test(
  'store: values the vendor itself called invalid are never sent to the shared store',
  () => {
    const sent = storeContactsFrom('salesql', {
      emails: [
        { value: 'old.john@example.com', type: null, status: 'Invalid' },
        { value: 'gone.john@example.com', type: null, status: 'undeliverable' },
        { value: 'john.doe@example.com', type: null, status: 'Valid' },
        { value: 'j.doe@example.com', type: null, status: null },
      ],
      phones: [
        { value: '+15550100009', type: null, valid: false },
        { value: '+15550100001', type: null, valid: true },
        { value: '+15550100002', type: null, valid: null },
      ],
    })
    assertEquals(
      sent.map((c) => [c.value, c.verified ?? null]),
      [
        ['john.doe@example.com', true],
        ['j.doe@example.com', null],
        ['+15550100001', true],
        ['+15550100002', null],
      ],
    )
  },
)

Deno.test(
  'deadline: the pending wait and each store ask get only what is left; a vendor call needs its full time',
  async () => {
    let clock = 0
    const deadline = new Deadline(30_000, () => clock)
    assertEquals(deadline.left(), 30_000)
    clock = 27_000
    assertEquals(
      [deadline.cap(8_000), deadline.allows(VENDOR_CALL_NEEDS_MS)],
      [3_000, false],
    )
    clock = 40_000
    assertEquals([deadline.left(), deadline.cap(5_000)], [0, 0])

    // storeFirst: a `pending` answer waits at most what is left.
    clock = 0
    const short = new Deadline(2_000, () => clock)
    const waits: number[] = []
    let asks = 0
    await storeFirst(
      () => {
        asks++
        return Promise.resolve({
          status: 'not_found',
          emails: [],
          phones: [],
          pending: ['email'],
          retryAfterMs: 4_000,
        } as StoreAnswer)
      },
      ['email'],
      {
        sleep: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
        deadline: short,
      },
    )
    assertEquals([waits, asks], [[2_000], 2])
  },
)

Deno.test(
  'SalesQL: a call that timed out is recorded as such (it may have been charged)',
  async () => {
    Deno.env.set('SALESQL_API_URL', 'http://fake-salesql.test/v1')
    Deno.env.set('SALESQL_API_KEY', 'fake-key')
    const realFetch = globalThis.fetch
    try {
      globalThis.fetch = (() =>
        Promise.reject(
          new DOMException('The signal has been aborted', 'AbortError'),
        )) as typeof fetch
      const timedOut = await salesqlLookup({
        name: 'John Doe',
        linkedinUrl: 'https://www.linkedin.com/in/john-doe/',
        linkedinKey: KEY,
        company: null,
        title: null,
      })
      assertEquals(
        [timedOut.status, timedOut.error],
        ['error', SALESQL_TIMED_OUT],
      )
    } finally {
      globalThis.fetch = realFetch
      Deno.env.delete('SALESQL_API_URL')
      Deno.env.delete('SALESQL_API_KEY')
    }
  },
)

// --- SalesQL: local fake override, no URL in errors, phone de-dup --------------

Deno.test(
  'SalesQL: SALESQL_API_URL for a local fake; errors never carry the request; phones de-duplicated',
  async () => {
    Deno.env.delete('SALESQL_API_URL')
    assertEquals(salesqlBase(), SALESQL_DEFAULT_BASE)
    Deno.env.set('SALESQL_API_URL', 'http://fake-salesql.test/v1/')
    Deno.env.set('SALESQL_API_KEY', 'fake-key')
    const urls: string[] = []
    const candidate = {
      name: 'John Doe',
      linkedinUrl: 'https://www.linkedin.com/in/john-doe/',
      linkedinKey: KEY,
      company: null,
      title: null,
    }
    try {
      globalThis.fetch = ((input: string | URL) => {
        urls.push(String(input))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              emails: [
                {
                  email: 'john.doe@example.com',
                  type: 'Work',
                  status: 'Valid',
                },
              ],
              phones: [
                { phone: '+91 98765 43210', type: 'Mobile', is_valid: true },
                { phone: '9876543210', type: 'Mobile', is_valid: true },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }) as typeof fetch
      const found = await salesqlLookup(candidate)
      if (!urls[0]!.startsWith('http://fake-salesql.test/v1/persons/enrich?')) {
        throw new Error(urls[0])
      }
      assertEquals(found.phones.length, 1)

      globalThis.fetch = (() =>
        Promise.reject(
          new TypeError(
            'error sending request for url (http://fake-salesql.test/v1/persons/enrich?linkedin_url=john-doe)',
          ),
        )) as typeof fetch
      const failed = await salesqlLookup(candidate)
      assertEquals(failed.status, 'error')
      if (/linkedin|john-doe|http/.test(failed.error ?? ''))
        throw new Error(failed.error ?? '')
    } finally {
      Deno.env.delete('SALESQL_API_URL')
      Deno.env.delete('SALESQL_API_KEY')
    }
  },
)

// --- 8. A rate-limited store never sends Lyca to its own vendors (HIR-537) ---
//
// The contact service answers 429 `rate_limited` (with Retry-After) when a
// product sends too many requests a minute (contact-enrichment #20). With
// CONTACT_VENDORS_VIA_SERVICE off, that must not fall through to Lyca's own
// SalesQL / BetterContact the way a store outage does: index.ts runs the
// vendors only for storeFirst's `missing`, and returns at once on
// `rateLimited`.

const STORE = 'http://contact-store.test'
const PERSON = 'https://www.linkedin.com/in/john-doe/'
const STORE_ENV = [
  'CONTACT_ENRICHMENT_URL',
  'CONTACT_ENRICHMENT_API_KEY',
  'CONTACT_ENRICHMENT_TIMEOUT_MS',
]

/**
 * The store answers from `answers` in order; every fetch is recorded. Any
 * other host would be a vendor. Environment, fetch and console.warn are put
 * back afterwards.
 */
async function withStore(
  answers: Array<() => Response>,
  fn: (urls: string[], warns: string[]) => Promise<void>,
) {
  const before = STORE_ENV.map((k) => Deno.env.get(k))
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  const urls: string[] = []
  const warns: string[] = []
  Deno.env.set('CONTACT_ENRICHMENT_URL', STORE)
  Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
  Deno.env.delete('CONTACT_ENRICHMENT_TIMEOUT_MS')
  let next = 0
  globalThis.fetch = ((input: string | URL) => {
    const url = String(input)
    urls.push(url)
    if (!url.startsWith(STORE)) {
      return Promise.resolve(
        new Response('vendor must not be called', { status: 599 }),
      )
    }
    const answer = answers[next++]
    if (!answer) return Promise.reject(new Error(`unexpected call ${url}`))
    return Promise.resolve(answer())
  }) as typeof fetch
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '))
  try {
    await fn(urls, warns)
  } finally {
    console.warn = realWarn
    globalThis.fetch = realFetch
    STORE_ENV.forEach((k, i) => {
      const v = before[i]
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    })
  }
}

const storeReply =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })

const RATE_LIMITED = storeReply(
  { error: { code: 'rate_limited', message: 'Too many requests' } },
  429,
  { 'Retry-After': '30' },
)

const askStoreFor = (
  kinds: ContactKind[],
  onUnavailable: (err: unknown) => void,
) =>
  storeFirst(() => contactStoreLookup(PERSON, kinds), kinds, {
    onUnavailable,
    sleep: () => Promise.resolve(),
  })

Deno.test(
  'rate limit: a store 429 calls no vendor, says "temporarily unavailable" and records no miss',
  async () => {
    await withStore([RATE_LIMITED], async (urls, warns) => {
      let reported: unknown = null
      const r = await askStoreFor(['email', 'phone'], (err) => {
        reported = err
      })
      // Nothing for the vendors: index.ts calls neither SalesQL nor BetterContact.
      assertEquals(r, { fromStore: null, missing: [], rateLimited: true })
      assertEquals(urls, [`${STORE}/v1/contacts/lookup`])
      assertEquals(isRateLimited(reported), true)
      assertEquals((reported as ContactStoreUnavailable).retryAfter, '30')
      // One warning, with the status and Retry-After, never a contact value.
      assertEquals(warns.length, 1)
      if (!warns[0]!.includes('HTTP 429 rate_limited, Retry-After: 30')) {
        throw new Error(warns[0])
      }
      // Recorded as an outage (status 'error'), never 'not_found'.
      const row = storeRowAfterAsk(null, r.fromStore, reported !== null)
      assertEquals(row, {
        status: 'error',
        emails: [],
        phones: [],
        error: STORE_UNREACHABLE,
      })
      const rows: PersonRows = { shared: row! }
      assertEquals(
        [kindUnavailable(rows, 'email'), kindUnavailable(rows, 'phone')],
        [true, true],
      )
      // Not final: the store counts as not asked, so the next "Get contact"
      // asks it again before any vendor.
      assertEquals(storeAsked(rows), false)
      assertEquals(kindsForStore(rows, ['email', 'phone'], true), [
        'email',
        'phone',
      ])
      // A row that already holds a value is left as it was.
      assertEquals(
        storeRowAfterAsk(
          {
            status: 'found',
            emails: [
              { value: 'john.doe@example.com', type: null, status: null },
            ],
            phones: [],
          },
          r.fromStore,
          true,
        ),
        null,
      )
    })
  },
)

Deno.test(
  'rate limit: a 429 on the second ask (after `pending`) keeps the first answer and calls no vendor',
  async () => {
    await withStore(
      [
        storeReply({
          emails: [
            {
              value: 'john.doe@example.com',
              status: 'unknown',
              verified: null,
            },
          ],
          phones: [],
          pending: ['phone'],
          retry_after_ms: 10,
        }),
        RATE_LIMITED,
      ],
      async (urls) => {
        let reported = 0
        const r = await askStoreFor(['email', 'phone'], () => reported++)
        assertEquals(urls.length, 2)
        assertEquals(r.missing, [])
        assertEquals(r.rateLimited, true)
        assertEquals(
          r.fromStore?.emails.map((e) => e.value),
          ['john.doe@example.com'],
        )
        assertEquals(reported, 1)
      },
    )
  },
)

Deno.test(
  'rate limit: a real outage (503, timeout, refused connection) still falls back to the vendors',
  async () => {
    for (const fail of [
      storeReply({ error: { code: 'store_unavailable' } }, 503),
      (): Response => {
        throw new DOMException('timed out', 'TimeoutError')
      },
      (): Response => {
        throw new TypeError('connection refused')
      },
    ]) {
      await withStore([fail], async (urls) => {
        let reported = 0
        const r = await askStoreFor(['email', 'phone'], () => reported++)
        assertEquals(r, { fromStore: null, missing: ['email', 'phone'] })
        assertEquals([urls.length, reported], [1, 1])
        assertEquals(storeRowAfterAsk(null, r.fromStore, true)?.status, 'error')
      })
    }
    // A store that answered "nothing" is a real miss: the vendors run.
    await withStore([storeReply({ emails: [], phones: [] })], async () => {
      let reported = 0
      const r = await askStoreFor(['email'], () => reported++)
      assertEquals(r, { fromStore: null, missing: ['email'] })
      assertEquals(reported, 0)
      assertEquals(
        storeRowAfterAsk(null, r.fromStore, false)?.status,
        'not_found',
      )
    })
  },
)
