// claims.ts on a service-role Supabase client: candidate_contact_claims
// (migration 20261029000002_contact_lookup_claims.sql). Errors carry the
// database's error code only. Every call gives up after CLAIM_DB_TIMEOUT_MS
// (HIR-528 review): a claim call that hangs fails the request before any
// vendor is paid, and a hung release only leaves a claim that goes stale.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { ClaimStore } from './claims.ts'

const CLAIMS = 'candidate_contact_claims'
/** One claim query may take this long. */
export const CLAIM_DB_TIMEOUT_MS = 5_000

const timeout = () => AbortSignal.timeout(CLAIM_DB_TIMEOUT_MS)

function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: database error ${error?.code ?? ''}`.trim())
}

export function supabaseClaims(client: SupabaseClient): ClaimStore {
  return {
    async tryClaim(key, vendor, claimId, staleBefore) {
      // A claim left by a request that died is removed first. This only ever
      // matches a stale row, never a live claim of another request.
      const stale = await client
        .from(CLAIMS)
        .delete()
        .eq('linkedin_key', key)
        .eq('vendor', vendor)
        .lt('claimed_at', staleBefore)
        .abortSignal(timeout())
      if (stale.error) fail('clear stale claim', stale.error)
      // INSERT … ON CONFLICT DO NOTHING: exactly one request gets its row back.
      const { data, error } = await client
        .from(CLAIMS)
        .upsert(
          { linkedin_key: key, vendor, claim_id: claimId },
          { onConflict: 'linkedin_key,vendor', ignoreDuplicates: true },
        )
        .select('claim_id')
        .abortSignal(timeout())
      if (error) fail('claim', error)
      return (data ?? []).some(
        (r: { claim_id?: string }) => r.claim_id === claimId,
      )
    },
    async held(key, vendor, staleBefore) {
      const { data, error } = await client
        .from(CLAIMS)
        .select('claim_id')
        .eq('linkedin_key', key)
        .eq('vendor', vendor)
        .gte('claimed_at', staleBefore)
        .limit(1)
        .abortSignal(timeout())
      if (error) fail('read claim', error)
      return (data ?? []).length > 0
    },
    async release(key, vendor, claimId) {
      const { error } = await client
        .from(CLAIMS)
        .delete()
        .eq('linkedin_key', key)
        .eq('vendor', vendor)
        .eq('claim_id', claimId)
        .abortSignal(timeout())
      if (error) fail('release claim', error)
    },
    async refresh(key, vendor, claimId) {
      const { data, error } = await client
        .from(CLAIMS)
        .update({ claimed_at: new Date().toISOString() })
        .eq('linkedin_key', key)
        .eq('vendor', vendor)
        .eq('claim_id', claimId)
        .select('claim_id')
        .abortSignal(timeout())
      if (error) fail('refresh claim', error)
      return (data ?? []).length > 0
    },
  }
}
