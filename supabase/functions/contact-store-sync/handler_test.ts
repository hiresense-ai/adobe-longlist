// deno test --allow-env supabase/functions/contact-store-sync/handler_test.ts
//
// HIR-526: the scheduled catch-up. Invented people only.
import {
  handleSync,
  MIN_SECRET_LENGTH,
  sameSecret,
  SECRET_HEADER,
} from './handler.ts'
import type {
  FeedbackSyncRow,
  LookupSyncRow,
  PersonSyncRow,
  SyncDb,
} from '../candidate-contacts/store-sync.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const SECRET = 'test-sync-secret-'.padEnd(48, 'x')
const JOHN = 'https://www.linkedin.com/in/john-doe/'

function configureStore(on: boolean) {
  if (on) {
    Deno.env.set('CONTACT_ENRICHMENT_URL', 'http://contact-store.test')
    Deno.env.set('CONTACT_ENRICHMENT_API_KEY', 'lyca-test-key')
  } else {
    Deno.env.delete('CONTACT_ENRICHMENT_URL')
    Deno.env.delete('CONTACT_ENRICHMENT_API_KEY')
  }
}

/** A store whose /ready answers `readyStatus`; saves and feedback land. */
function fakeStore() {
  const state = { readyStatus: 200, calls: [] as string[] }
  globalThis.fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname
    state.calls.push(path)
    if (path === '/ready') {
      return new Response(
        JSON.stringify(
          state.readyStatus === 200
            ? { status: 'ready' }
            : { code: 'store_unavailable' },
        ),
        { status: state.readyStatus },
      )
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return state
}

type Row = LookupSyncRow & { status: string; store_synced_at: string | null }

function fakeDb(
  rows: Row[],
  feedback: Array<FeedbackSyncRow & { store_synced_at: string | null }> = [],
) {
  const state = { opened: 0 }
  const db: SyncDb = {
    settleLookups: () => Promise.resolve(0),
    unsyncedLookups: (limit) =>
      Promise.resolve(
        rows
          .filter((r) => !r.store_synced_at)
          .slice(0, limit)
          .map((r) => ({ ...r })),
      ),
    unsyncedFeedback: (limit) =>
      Promise.resolve(
        feedback
          .filter((r) => !r.store_synced_at)
          .slice(0, limit)
          .map((r) => ({ ...r })),
      ),
    personRows: (keys) =>
      Promise.resolve(
        rows
          .filter((r) => keys.includes(r.linkedin_key))
          .map((r) => ({ ...r })) as PersonSyncRow[],
      ),
    markLookup: (id, updatedAt) => {
      const r = rows.find(
        (x) => x.id === id && x.updated_at === updatedAt && !x.store_synced_at,
      )
      if (r) r.store_synced_at = new Date().toISOString()
      return Promise.resolve(!!r)
    },
    markFeedback: (id, updatedAt) => {
      const r = feedback.find(
        (x) => x.id === id && x.updated_at === updatedAt && !x.store_synced_at,
      )
      if (r) r.store_synced_at = new Date().toISOString()
      return Promise.resolve(!!r)
    },
  }
  return {
    state,
    open: () => {
      state.opened += 1
      return db
    },
  }
}

const row = (id: string): Row => ({
  id,
  linkedin_key: 'linkedin.com/in/john-doe',
  linkedin_url: JOHN,
  vendor: 'salesql',
  status: 'found',
  emails: [{ value: 'john@example.com', type: null, status: null }],
  phones: [{ value: '+15550100', type: null, valid: null }],
  updated_at: '2026-10-29T08:00:00.000Z',
  store_synced_at: null,
})

function call(secret: string | null, method = 'POST') {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (secret !== null) headers.set(SECRET_HEADER, secret)
  return new Request('http://localhost/functions/v1/contact-store-sync', {
    method,
    headers,
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
}

async function captureLogs<T>(
  run: () => Promise<T>,
): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  const keep = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  console.log = keep
  console.warn = keep
  console.error = keep
  try {
    return { out: await run(), lines }
  } finally {
    Object.assign(console, saved)
  }
}

Deno.test('secret: compared in constant time, exact match only', async () => {
  assertEquals(await sameSecret(SECRET, SECRET), true)
  assertEquals(await sameSecret(SECRET.slice(0, -1), SECRET), false)
  assertEquals(await sameSecret('', SECRET), false)
  assertEquals(await sameSecret(`${SECRET}x`, SECRET), false)
})

Deno.test(
  'refuses everything while the secret is unset or short, a wrong secret, and GET',
  async () => {
    configureStore(true)
    const store = fakeStore()
    const { state, open } = fakeDb([row('l-1')])
    for (const secret of [
      undefined,
      '',
      'short'.padEnd(MIN_SECRET_LENGTH - 1, 'x'),
    ]) {
      const res = await handleSync(call(secret ?? 'anything'), {
        secret,
        db: open,
      })
      assertEquals(res.status, 503)
    }
    assertEquals(
      (await handleSync(call(null), { secret: SECRET, db: open })).status,
      401,
    )
    assertEquals(
      (await handleSync(call('wrong'), { secret: SECRET, db: open })).status,
      401,
    )
    assertEquals(
      (await handleSync(call(SECRET, 'GET'), { secret: SECRET, db: open }))
        .status,
      405,
    )
    // Nothing was read or sent.
    assertEquals(state.opened, 0)
    assertEquals(store.calls, [])
  },
)

Deno.test('does nothing while the store is not configured', async () => {
  configureStore(false)
  const store = fakeStore()
  const { state, open } = fakeDb([row('l-1')])
  const res = await handleSync(call(SECRET), { secret: SECRET, db: open })
  assertEquals(await res.json(), {
    status: 'skipped',
    reason: 'store_not_configured',
  })
  assertEquals(state.opened, 0)
  assertEquals(store.calls, [])
})

Deno.test(
  'does nothing while /ready fails, and catches up once it is ready',
  async () => {
    configureStore(true)
    const store = fakeStore()
    const rows = [
      row('l-1'),
      { ...row('l-2'), updated_at: '2026-10-29T08:01:00.000Z' },
    ]
    const feedback = [
      {
        id: 'f-1',
        linkedin_key: 'linkedin.com/in/john-doe',
        contact_kind: 'email' as const,
        contact_value: 'john@example.com',
        vendor: 'salesql',
        verdict: 'bad' as const,
        reason: 'bounced',
        updated_at: '2026-10-29T08:02:00.000Z',
        store_synced_at: null,
      },
    ]
    const { state, open } = fakeDb(rows, feedback)

    for (const status of [503, 500]) {
      store.readyStatus = status
      const { out: res, lines } = await captureLogs(() =>
        handleSync(call(SECRET), { secret: SECRET, db: open }),
      )
      assertEquals(res.status, 200)
      assertEquals(await res.json(), {
        status: 'skipped',
        reason: 'store_not_ready',
      })
      assertEquals(lines.length, 1)
    }
    // The store down altogether (no answer at all) is the same.
    globalThis.fetch = (() =>
      Promise.reject(new TypeError('connection refused'))) as typeof fetch
    const down = await captureLogs(() =>
      handleSync(call(SECRET), { secret: SECRET, db: open }),
    )
    assertEquals(await down.out.json(), {
      status: 'skipped',
      reason: 'store_not_ready',
    })
    assertEquals(state.opened, 0)
    assertEquals(
      rows.map((r) => r.store_synced_at),
      [null, null],
    )

    // Ready again: everything goes, lookups before feedback, and the answer is counts only.
    const ready = fakeStore()
    const { out: res, lines } = await captureLogs(() =>
      handleSync(call(SECRET), { secret: SECRET, db: open }),
    )
    const body = await res.json()
    assertEquals(res.status, 200)
    assertEquals(body, {
      status: 'ok',
      lookups: { sent: 2, settled: 0, dropped_values: 0, failed: 0 },
      feedback: { sent: 1, waiting: 0, rejected: 0, failed: 0 },
      more: false,
    })
    assertEquals(ready.calls, [
      '/ready',
      '/v1/contacts',
      '/v1/contacts',
      '/v1/contacts/feedback',
    ])
    if (rows.some((r) => !r.store_synced_at) || !feedback[0]!.store_synced_at) {
      throw new Error('every row must be marked')
    }
    const text = lines.join('\n') + JSON.stringify(body)
    for (const v of ['john', 'example.com', '+1555', 'linkedin']) {
      if (text.includes(v))
        throw new Error(`contact data in the log or answer: ${text}`)
    }
  },
)

Deno.test(
  'a database failure answers 500 with no row content in the log',
  async () => {
    configureStore(true)
    fakeStore()
    const { open } = fakeDb([row('l-1')])
    const broken = () => ({
      ...open(),
      unsyncedLookups: () =>
        Promise.reject(new Error('john@example.com violates something')),
    })
    const { out: res, lines } = await captureLogs(() =>
      handleSync(call(SECRET), { secret: SECRET, db: broken }),
    )
    assertEquals(res.status, 500)
    assertEquals(await res.json(), { error: 'Sync failed' })
    const text = lines.join('\n')
    if (text.includes('john') || text.includes('example.com')) {
      throw new Error(`row content in the log: ${text}`)
    }
  },
)
