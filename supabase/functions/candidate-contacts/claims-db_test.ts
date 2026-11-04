// claims-db.ts against the real candidate_contact_claims table (HIR-528 review):
// the race is decided by Postgres (insert … on conflict do nothing), so it is
// tested there, not only with the in-memory store of hir528_test.ts.
//
// Runs only against a LOCAL Supabase stack (npm run lyca:start), never a hosted
// project; skipped unless both variables are set:
//
//   LYCA_LOCAL_SUPABASE_URL=http://127.0.0.1:55321 \
//   LYCA_LOCAL_SERVICE_ROLE_KEY=<the local stack's service_role key> \
//   deno test --allow-env --allow-net=127.0.0.1 \
//     supabase/functions/candidate-contacts/claims-db_test.ts
//
// Invented people only (claims-test-<uuid>); every row it writes is removed.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { supabaseClaims } from './claims-db.ts'
import { CLAIM_STALE_MS } from './claims.ts'
import { PaidAnswerNotSaved, salesqlOnce } from './paid.ts'
import type { VendorResult } from './vendors.ts'

const URL_ = Deno.env.get('LYCA_LOCAL_SUPABASE_URL') ?? ''
const KEY_ = Deno.env.get('LYCA_LOCAL_SERVICE_ROLE_KEY') ?? ''
const ignore = !URL_ || !KEY_
if (!ignore && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_)) {
  throw new Error('claims-db_test.ts runs only against a local stack')
}

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const ANSWER: VendorResult = {
  status: 'found',
  emails: [{ value: 'claims.test@example.com', type: null, status: 'Valid' }],
  phones: [],
}

async function client(): Promise<SupabaseClient> {
  const { createClient } = await import('npm:@supabase/supabase-js@2')
  return createClient(URL_, KEY_, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const testKey = () => `linkedin.com/in/claims-test-${crypto.randomUUID()}`

async function cleanup(db: SupabaseClient, key: string) {
  await db.from('candidate_contact_claims').delete().eq('linkedin_key', key)
}

async function rowsOf(db: SupabaseClient, key: string) {
  const { data, error } = await db
    .from('candidate_contact_claims')
    .select('vendor, claim_id, claimed_at')
    .eq('linkedin_key', key)
  if (error) throw new Error(`read: ${error.code}`)
  return data ?? []
}

const options = { sanitizeOps: false, sanitizeResources: false, ignore }

Deno.test({
  name: 'claims-db (local Postgres): five reveals of one person at once pay SalesQL once',
  ...options,
  async fn() {
    const db = await client()
    const key = testKey()
    try {
      let paid = 0
      let saved: VendorResult | null = null
      const reveal = () =>
        salesqlOnce({
          claims: supabaseClaims(db),
          key,
          readSaved: () => Promise.resolve(saved),
          lookup: async () => {
            paid++
            await new Promise((r) => setTimeout(r, 300)) // the vendor is slow
            return ANSWER
          },
          save: (result) => {
            saved = result
            return Promise.resolve()
          },
          options: { pollMs: 50, waitMs: 5_000 },
        })
      const outcomes = await Promise.all([1, 2, 3, 4, 5].map(reveal))
      assertEquals(paid, 1)
      assertEquals(saved, ANSWER)
      // Exactly one request held the claim while the call ran; the others
      // waited for it (or claimed after it and found the saved answer).
      for (const o of outcomes) {
        if (o.ran) assertEquals(o.value, ANSWER)
        else assertEquals(o, { ran: false, settled: true })
      }
      assertEquals(await rowsOf(db, key), []) // every claim released
    } finally {
      await cleanup(db, key)
    }
  },
})

Deno.test({
  name: 'claims-db (local Postgres): stale takeover, release and refresh only touch your own claim',
  ...options,
  async fn() {
    const db = await client()
    const claims = supabaseClaims(db)
    const key = testKey()
    try {
      const old = new Date(Date.now() - 10 * 60_000).toISOString()
      const staleBefore = () =>
        new Date(Date.now() - CLAIM_STALE_MS).toISOString()
      const { error } = await db.from('candidate_contact_claims').insert({
        linkedin_key: key,
        vendor: 'salesql',
        claim_id: crypto.randomUUID(),
        claimed_at: old,
      })
      if (error) throw new Error(`insert: ${error.code}`)
      // A live claim is not taken; a stale one is.
      assertEquals(await claims.held(key, 'salesql', staleBefore()), false)
      const mine = crypto.randomUUID()
      assertEquals(
        await claims.tryClaim(key, 'salesql', mine, staleBefore()),
        true,
      )
      const theirs = crypto.randomUUID()
      assertEquals(
        await claims.tryClaim(key, 'salesql', theirs, staleBefore()),
        false,
      )
      assertEquals(await claims.held(key, 'salesql', staleBefore()), true)
      // Another vendor of the same person is a separate claim.
      assertEquals(
        await claims.tryClaim(key, 'bettercontact', theirs, staleBefore()),
        true,
      )
      // Refresh and release act only on the caller's own claim.
      assertEquals(await claims.refresh(key, 'salesql', theirs), false)
      const before = (await rowsOf(db, key)).find((r) => r.vendor === 'salesql')
      await new Promise((r) => setTimeout(r, 20))
      assertEquals(await claims.refresh(key, 'salesql', mine), true)
      const after = (await rowsOf(db, key)).find((r) => r.vendor === 'salesql')
      if (!(Date.parse(after!.claimed_at) > Date.parse(before!.claimed_at))) {
        throw new Error('refresh did not move claimed_at')
      }
      await claims.release(key, 'salesql', theirs)
      assertEquals((await rowsOf(db, key)).length, 2)
      await claims.release(key, 'salesql', mine)
      await claims.release(key, 'bettercontact', theirs)
      assertEquals(await rowsOf(db, key), [])
    } finally {
      await cleanup(db, key)
    }
  },
})

Deno.test({
  name: 'claims-db (local Postgres): a paid answer that could not be saved keeps the claim; the next reveal pays nothing',
  ...options,
  async fn() {
    const db = await client()
    const key = testKey()
    const quiet = { warn: console.warn, error: console.error }
    console.warn = () => {}
    console.error = () => {}
    try {
      let paid = 0
      const reveal = (waitMs: number) =>
        salesqlOnce({
          claims: supabaseClaims(db),
          key,
          readSaved: () => Promise.resolve(null),
          lookup: () => {
            paid++
            return Promise.resolve(ANSWER)
          },
          save: () => Promise.reject({ code: '08006' }),
          options: { pollMs: 50, waitMs },
          sleep: () => Promise.resolve(),
        })
      let lost = false
      try {
        await reveal(1_000)
      } catch (err) {
        lost = err instanceof PaidAnswerNotSaved
      }
      assertEquals([lost, paid], [true, 1])
      assertEquals((await rowsOf(db, key)).length, 1) // kept
      assertEquals(await reveal(200), { ran: false, settled: false })
      assertEquals(paid, 1)
    } finally {
      Object.assign(console, quiet)
      await cleanup(db, key)
    }
  },
})
