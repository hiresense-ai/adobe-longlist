// deno test --allow-env supabase/functions/candidate-contacts/store-sync_test.ts
//
// HIR-526: every revealed contact and every 👍/👎 reaches the shared store.
// Invented people only (john-doe, jane-roe, @example.com, +1555 numbers).
import {
  contactStoreFeedbackLater,
  contactStoreSaveLater,
} from './contact-store.ts'
import {
  runSync,
  upsertUnsynced,
  type FeedbackSyncRow,
  type LookupSyncRow,
  type PersonSyncRow,
  type SyncDb,
  type UpsertClient,
} from './store-sync.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const JOHN = 'https://www.linkedin.com/in/john-doe/'
const JANE = 'https://www.linkedin.com/in/jane-roe/'
const VALUES = [
  'john-doe',
  'jane-roe',
  'john@example.com',
  'john.doe@example.com',
  'jane@example.com',
  '+15550100',
  '+15550101',
]

function configure() {
  Deno.env.set('CONTACT_ENRICHMENT_URL', 'http://contact-store.test')
  Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
}

// --- A fake contact store ---------------------------------------------------

type Call = { path: string; body: Record<string, unknown> }

interface FakeStore {
  calls: Call[]
  /** kind|value pairs held per profile URL. */
  held: Set<string>
  down: boolean
  /** Values the store refuses (422 invalid_contact_value). */
  invalid: Set<string>
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    held: new Set(),
    down: false,
    invalid: new Set(),
  }
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    store.calls.push({ path, body })
    if (store.down)
      throw new TypeError('error sending request: connection refused')
    if (path === '/ready') return reply({ status: 'ready' })
    if (path === '/v1/contacts') {
      const contacts = body.contacts as Array<{ kind: string; value: string }>
      if (contacts.some((c) => store.invalid.has(c.value))) {
        return reply({ error: { code: 'invalid_contact_value' } }, 422)
      }
      for (const c of contacts)
        store.held.add(`${body.linkedin_url}|${c.kind}|${c.value}`)
      return reply({ emails: [], phones: [] })
    }
    if (path === '/v1/contacts/feedback') {
      const key = `${body.linkedin_url}|${body.kind}|${body.value}`
      if (!store.held.has(key))
        return reply({ error: { code: 'contact_not_found' } }, 404)
      return reply({ emails: [], phones: [] })
    }
    return reply({ error: { code: 'not_found' } }, 404)
  }) as typeof fetch
  return store
}

// --- A fake Lyca database (same rules as store-sync-db.ts) ------------------

interface LookupRow extends LookupSyncRow {
  status: string
  store_synced_at: string | null
}
interface FeedbackRow extends FeedbackSyncRow {
  store_synced_at: string | null
}

let clock = 0
const stamp = () =>
  new Date(Date.UTC(2026, 9, 29, 8, 0, 0, ++clock)).toISOString()

function fakeDb(lookups: LookupRow[], feedback: FeedbackRow[] = []) {
  const marks: string[] = []
  const empty = (v: unknown) => !Array.isArray(v) || v.length === 0
  const db: SyncDb = {
    settleLookups() {
      let n = 0
      for (const r of lookups) {
        if (r.store_synced_at !== null) continue
        if (
          r.vendor === 'contact_store' ||
          (empty(r.emails) && empty(r.phones))
        ) {
          r.store_synced_at = stamp()
          n += 1
        }
      }
      return Promise.resolve(n)
    },
    unsyncedLookups(limit) {
      // Deliberately NOT filtered by vendor: runSync itself must never send
      // the store's own answers back.
      return Promise.resolve(
        lookups
          .filter((r) => r.store_synced_at === null)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit)
          .map((r) => structuredClone(r)),
      )
    },
    unsyncedFeedback(limit) {
      return Promise.resolve(
        feedback
          .filter((r) => r.store_synced_at === null)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit)
          .map((r) => structuredClone(r)),
      )
    },
    personRows(keys) {
      return Promise.resolve(
        lookups
          .filter((r) => keys.includes(r.linkedin_key))
          .map((r) => structuredClone(r)) as PersonSyncRow[],
      )
    },
    markLookup(id, updatedAt) {
      const r = lookups.find((x) => x.id === id)
      if (!r || r.updated_at !== updatedAt || r.store_synced_at !== null) {
        return Promise.resolve(false)
      }
      r.store_synced_at = stamp()
      marks.push(id)
      return Promise.resolve(true)
    },
    markFeedback(id, updatedAt) {
      const r = feedback.find((x) => x.id === id)
      if (!r || r.updated_at !== updatedAt || r.store_synced_at !== null) {
        return Promise.resolve(false)
      }
      r.store_synced_at = stamp()
      marks.push(id)
      return Promise.resolve(true)
    },
  }
  return { db, marks }
}

function lookup(id: string, over: Partial<LookupRow> = {}): LookupRow {
  return {
    id,
    linkedin_key: 'linkedin.com/in/john-doe',
    linkedin_url: JOHN,
    vendor: 'salesql',
    status: 'found',
    emails: [{ value: 'john@example.com', type: 'Work', status: 'Valid' }],
    phones: [{ value: '+15550100', type: 'Mobile', valid: null }],
    updated_at: stamp(),
    store_synced_at: null,
    ...over,
  }
}

function thumb(id: string, over: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id,
    linkedin_key: 'linkedin.com/in/john-doe',
    contact_kind: 'email',
    contact_value: 'john@example.com',
    vendor: 'salesql',
    verdict: 'bad',
    reason: 'no_answer',
    updated_at: stamp(),
    store_synced_at: null,
    ...over,
  }
}

/** Every console line written while `run` runs. */
async function captureLogs<T>(
  run: () => Promise<T>,
): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  const keep = (...args: unknown[]) =>
    lines.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    )
  console.log = keep
  console.warn = keep
  console.error = keep
  try {
    return { out: await run(), lines }
  } finally {
    Object.assign(console, saved)
  }
}

function assertNoContactData(text: string) {
  for (const v of VALUES) {
    if (text.includes(v))
      throw new Error(`a contact value reached the log/answer: ${text}`)
  }
  if (/linkedin\.com|@|\+1555/.test(text))
    throw new Error(`contact data in: ${text}`)
}

// --- Writes reset the mark ----------------------------------------------------

Deno.test(
  'every upsert writes store_synced_at null and a fresh updated_at, and returns that version',
  async () => {
    const sent: Array<{
      table: string
      values: Record<string, unknown>
      onConflict: string
    }> = []
    const client: UpsertClient = {
      from: (table) => ({
        upsert: (values, options) => {
          sent.push({ table, values, onConflict: options.onConflict })
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'row-1', updated_at: values.updated_at },
                  error: null,
                }),
            }),
          }
        },
      }),
    }
    // A row the store already had (synced earlier) gets new values: the mark goes.
    const version = await upsertUnsynced(
      client,
      'candidate_contact_lookups',
      {
        linkedin_key: 'linkedin.com/in/john-doe',
        vendor: 'bettercontact',
        status: 'found',
        emails: [{ value: 'john.doe@example.com', type: null, status: null }],
        store_synced_at: '2026-10-29T07:00:00.000Z',
        updated_at: '2026-10-29T07:00:00.000Z',
      },
      'linkedin_key,vendor',
    )
    assertEquals(sent[0]!.values.store_synced_at, null)
    assertEquals(sent[0]!.onConflict, 'linkedin_key,vendor')
    if (sent[0]!.values.updated_at === '2026-10-29T07:00:00.000Z') {
      throw new Error('updated_at must be fresh on every write')
    }
    assertEquals(version, {
      id: 'row-1',
      updated_at: sent[0]!.values.updated_at,
    })

    await upsertUnsynced(
      client,
      'candidate_contact_feedback',
      { contact_value: 'john.doe@example.com', verdict: 'good' },
      'linkedin_key,contact_kind,contact_value',
    )
    assertEquals(sent[1]!.table, 'candidate_contact_feedback')
    assertEquals(sent[1]!.values.store_synced_at, null)

    // A write error is thrown as before (the request then fails, nothing is marked).
    const failing: UpsertClient = {
      from: () => ({
        upsert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: null, error: { code: '23514' } }),
          }),
        }),
      }),
    }
    let threw = false
    try {
      await upsertUnsynced(
        failing,
        'candidate_contact_lookups',
        {},
        'linkedin_key,vendor',
      )
    } catch {
      threw = true
    }
    assertEquals(threw, true)
  },
)

// --- The background send marks the row ---------------------------------------

Deno.test(
  'a background save that lands marks the row; a failed one leaves it unsynced',
  async () => {
    configure()
    delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime
    const store = fakeStore()
    let marked = 0
    const done: Promise<unknown>[] = []
    const mark = () => {
      marked += 1
    }
    // inBackground hands nothing back outside the edge runtime, so wait on the store's answer.
    ;(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = {
      waitUntil: (p: Promise<unknown>) => done.push(p),
    }
    try {
      contactStoreSaveLater(
        JOHN,
        'salesql',
        {
          emails: [{ value: 'john@example.com', type: null, status: 'Valid' }],
          phones: [{ value: '+15550100', type: null, valid: true }],
        },
        mark,
      )
      await Promise.all(done)
      assertEquals(marked, 1)
      assertEquals(store.held.has(`${JOHN}|email|john@example.com`), true)

      store.down = true
      const { lines } = await captureLogs(async () => {
        contactStoreSaveLater(
          JOHN,
          'salesql',
          {
            emails: [{ value: 'john@example.com', type: null, status: null }],
            phones: [],
          },
          mark,
        )
        contactStoreFeedbackLater(
          JOHN,
          'email',
          'john@example.com',
          'bad',
          'bounced',
          mark,
        )
        await Promise.all(done)
      })
      assertEquals(marked, 1) // neither failed send marked anything
      assertNoContactData(lines.join('\n'))

      // A 404 (the store does not hold the value yet) leaves the 👍/👎 unsynced too.
      store.down = false
      store.held.clear()
      await captureLogs(async () => {
        contactStoreFeedbackLater(
          JOHN,
          'email',
          'john@example.com',
          'good',
          null,
          mark,
        )
        await Promise.all(done)
      })
      assertEquals(marked, 1)

      store.held.add(`${JOHN}|email|john@example.com`)
      contactStoreFeedbackLater(
        JOHN,
        'email',
        'john@example.com',
        'good',
        null,
        mark,
      )
      await Promise.all(done)
      assertEquals(marked, 2)
    } finally {
      delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime
    }
  },
)

Deno.test(
  'a background save of more than 20 values goes in batches of 20 and marks once',
  async () => {
    configure()
    const store = fakeStore()
    const done: Promise<unknown>[] = []
    ;(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = {
      waitUntil: (p: Promise<unknown>) => done.push(p),
    }
    let marked = 0
    try {
      const emails = Array.from({ length: 25 }, (_, i) => ({
        value: `john${i}@example.com`,
        type: null,
        status: null,
      }))
      contactStoreSaveLater(
        JOHN,
        'bettercontact',
        { emails, phones: [] },
        () => (marked += 1),
      )
      await Promise.all(done)
      assertEquals(
        store.calls.map((c) => (c.body.contacts as unknown[]).length),
        [20, 5],
      )
      assertEquals(marked, 1)
    } finally {
      delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime
    }
  },
)

// --- The sync job -------------------------------------------------------------

Deno.test(
  'sync: unsynced vendor rows are sent oldest first and marked; failures stay unsynced',
  async () => {
    configure()
    const store = fakeStore()
    const older = lookup('l-old', { vendor: 'bettercontact', phones: [] })
    const newer = lookup('l-new', {
      linkedin_key: 'linkedin.com/in/jane-roe',
      linkedin_url: JANE,
      emails: [{ value: 'jane@example.com', type: null, status: null }],
      phones: [],
    })
    const { db } = fakeDb([newer, older])

    store.down = true
    const down = await captureLogs(() => runSync(db))
    assertEquals(down.out.status, 'stopped')
    assertEquals(down.out.lookups.failed, 1) // stopped at the first row
    assertEquals([older.store_synced_at, newer.store_synced_at], [null, null])
    assertNoContactData(down.lines.join('\n') + JSON.stringify(down.out))

    store.down = false
    store.calls.length = 0
    const up = await runSync(db)
    assertEquals(up.status, 'ok')
    assertEquals(up.lookups, {
      sent: 2,
      settled: 0,
      dropped_values: 0,
      failed: 0,
    })
    assertEquals(
      store.calls.map((c) => c.body.linkedin_url),
      [JOHN, JANE],
    )
    assertEquals(store.calls[0]!.body.contacts, [
      {
        kind: 'email',
        value: 'john@example.com',
        vendor: 'bettercontact',
        verified: true,
      },
    ])
    if (!older.store_synced_at || !newer.store_synced_at)
      throw new Error('both must be marked')

    // Nothing left: the next run sends nothing.
    store.calls.length = 0
    const again = await runSync(db)
    assertEquals(store.calls.length, 0)
    assertEquals(again.more, false)
  },
)

Deno.test(
  "sync: the store's own answers and rows without values are marked, never sent",
  async () => {
    configure()
    const store = fakeStore()
    const shared = lookup('l-store', { vendor: 'contact_store' })
    const notFound = lookup('l-none', {
      status: 'not_found',
      emails: [],
      phones: [],
    })
    const malformed = lookup('l-bad', {
      emails: [{ value: '' }, null],
      phones: 'x',
    })
    const { db } = fakeDb([shared, notFound, malformed])
    // Even if a contact_store row reaches the loop, it is not sent.
    const leak = { ...db, settleLookups: () => Promise.resolve(0) }
    const counts = await runSync(leak)
    assertEquals(store.calls.length, 0)
    assertEquals(counts.lookups.settled, 3)
    for (const r of [shared, notFound, malformed]) {
      if (!r.store_synced_at) throw new Error(`${r.id} must be marked`)
    }

    const viaSettle = lookup('l-store-2', { vendor: 'contact_store' })
    const { db: db2 } = fakeDb([viaSettle])
    assertEquals((await runSync(db2)).lookups.settled, 1)
    assertEquals(store.calls.length, 0)
  },
)

Deno.test(
  'sync: a row changed while being sent is not marked (its newer values go next run)',
  async () => {
    configure()
    const store = fakeStore()
    const row = lookup('l-1')
    const { db } = fakeDb([row])
    const base = globalThis.fetch
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      // A reveal writes new values for this person while the job's call is in flight.
      row.emails = [{ value: 'john.doe@example.com', type: null, status: null }]
      row.updated_at = stamp()
      row.store_synced_at = null
      return await base(input, init)
    }) as typeof fetch
    const first = await runSync(db)
    assertEquals(first.lookups.sent, 0)
    assertEquals(row.store_synced_at, null)
    globalThis.fetch = base
    const second = await runSync(db)
    assertEquals(second.lookups.sent, 1)
    assertEquals(store.held.has(`${JOHN}|email|john.doe@example.com`), true)
  },
)

Deno.test(
  'sync: feedback waits for its values, then goes; a 404 saves the value and retries',
  async () => {
    configure()
    const store = fakeStore()
    const values = lookup('l-1')
    const fb = thumb('f-1')
    const { db } = fakeDb([values], [fb])

    // Room for one row only: the lookup goes, the feedback waits (values first).
    const one = await runSync(db, { maxRows: 1 })
    assertEquals(one.lookups.sent, 1)
    assertEquals(one.more, true)
    assertEquals(fb.store_synced_at, null)

    const two = await runSync(db)
    assertEquals(two.feedback, { sent: 1, waiting: 0, rejected: 0, failed: 0 })
    const last = store.calls.at(-1)!
    assertEquals(last.body, {
      linkedin_url: JOHN,
      kind: 'email',
      value: 'john@example.com',
      verdict: 'bad',
      reason: 'not_reachable',
    })

    // An unsynced vendor row holding values: its feedback waits for it.
    const store2 = fakeStore()
    store2.down = false
    const pending = lookup('l-2', { store_synced_at: null })
    const fb2 = thumb('f-2', { verdict: 'good', reason: null })
    const { db: db2 } = fakeDb([pending], [fb2])
    const leak = { ...db2, unsyncedLookups: () => Promise.resolve([]) }
    const waited = await runSync(leak)
    assertEquals(waited.feedback.waiting, 1)
    assertEquals(store2.calls.length, 0)

    // The store lost the value (404): it is saved from Lyca's own row, then the 👍/👎 again.
    const store3 = fakeStore()
    const synced = lookup('l-3', {
      store_synced_at: '2026-10-29T07:00:00.000Z',
    })
    const fb3 = thumb('f-3', { verdict: 'good', reason: null })
    const { db: db3 } = fakeDb([synced], [fb3])
    const retried = await runSync(db3)
    assertEquals(retried.feedback.sent, 1)
    assertEquals(
      store3.calls.map((c) => c.path),
      ['/v1/contacts/feedback', '/v1/contacts', '/v1/contacts/feedback'],
    )
    assertEquals(store3.calls[1]!.body.contacts, [
      {
        kind: 'email',
        value: 'john@example.com',
        vendor: 'salesql',
        verified: true,
      },
    ])
    if (!fb3.store_synced_at) throw new Error('feedback must be marked')
  },
)

Deno.test(
  'sync: values the store refuses are dropped, the rest saved, the row marked',
  async () => {
    configure()
    const store = fakeStore()
    store.invalid.add('+15550101')
    const row = lookup('l-1', {
      phones: [
        { value: '+15550101', type: null, valid: null },
        { value: '+15550100', type: null, valid: true },
      ],
    })
    const orphan = thumb('f-1', {
      linkedin_key: 'linkedin.com/in/jane-roe',
      contact_value: 'jane@example.com',
    })
    const { db } = fakeDb([row], [orphan])
    const { out, lines } = await captureLogs(() => runSync(db))
    assertEquals(out.lookups, {
      sent: 1,
      settled: 0,
      dropped_values: 1,
      failed: 0,
    })
    assertEquals(store.held.has(`${JOHN}|phone|+15550100`), true)
    assertEquals(store.held.has(`${JOHN}|email|john@example.com`), true)
    // A 👍/👎 on a value no row of Lyca's holds can never land: dropped, not retried forever.
    assertEquals(out.feedback.rejected, 1)
    if (!orphan.store_synced_at)
      throw new Error('orphan feedback must be marked')
    assertNoContactData(lines.join('\n') + JSON.stringify(out))
  },
)

Deno.test('sync: bounded by rows per run and by time', async () => {
  configure()
  const store = fakeStore()
  const rows = Array.from({ length: 5 }, (_, i) => lookup(`l-${i}`))
  const { db } = fakeDb(rows)
  const capped = await runSync(db, { maxRows: 2 })
  assertEquals(capped.lookups.sent, 2)
  assertEquals(capped.more, true)

  let t = 0
  store.calls.length = 0
  const timed = await runSync(db, { budgetMs: 100, now: () => (t += 60) })
  // started at 60, deadline 160: row at 120 goes, the next check (180) stops.
  assertEquals(timed.lookups.sent, 1)
  assertEquals(timed.more, true)
  assertEquals(rows.filter((r) => r.store_synced_at === null).length, 2)
})
