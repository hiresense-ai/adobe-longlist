// claims.ts on a service-role Supabase client: candidate_contact_claims
// (migration 20261029000002_contact_lookup_claims.sql). Errors carry the
// database's error code only.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { ClaimStore } from './claims.ts'

const CLAIMS = 'candidate_contact_claims'

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
      if (stale.error) fail('clear stale claim', stale.error)
      // INSERT … ON CONFLICT DO NOTHING: exactly one request gets its row back.
      const { data, error } = await client
        .from(CLAIMS)
        .upsert(
          { linkedin_key: key, vendor, claim_id: claimId },
          { onConflict: 'linkedin_key,vendor', ignoreDuplicates: true },
        )
        .select('claim_id')
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
      if (error) fail('release claim', error)
    },
  }
}
