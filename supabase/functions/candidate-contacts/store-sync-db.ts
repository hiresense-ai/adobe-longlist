// store-sync.ts's database side, on a service-role Supabase client: the
// unsynced rows of candidate_contact_lookups / candidate_contact_feedback and
// the "synced" mark (HIR-526). Errors are rethrown as SyncDbError with the
// database's error code only, so no row content can reach a log.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  SyncDbError,
  type FeedbackSyncRow,
  type LookupSyncRow,
  type PersonSyncRow,
  type SyncDb,
} from './store-sync.ts'

type Client = SupabaseClient

const LOOKUPS = 'candidate_contact_lookups'
const FEEDBACK = 'candidate_contact_feedback'

function fail(what: string, error: { code?: string } | null): never {
  throw new SyncDbError(`${what}: database error ${error?.code ?? ''}`.trim())
}

/**
 * Marks one row synced, only while it is unchanged since it was read or
 * written (same updated_at) and still unsynced: a newer version written in
 * the meantime keeps null and is sent next time. Never touches updated_at.
 */
export async function markSynced(
  client: Client,
  table: typeof LOOKUPS | typeof FEEDBACK,
  id: string,
  updatedAt: string,
): Promise<boolean> {
  const { data, error } = await client
    .from(table)
    .update({ store_synced_at: new Date().toISOString() })
    .eq('id', id)
    .eq('updated_at', updatedAt)
    .is('store_synced_at', null)
    .select('id')
  if (error) fail(`mark ${table}`, error)
  return (data?.length ?? 0) > 0
}

export function supabaseSyncDb(client: Client): SyncDb {
  return {
    async settleLookups() {
      const at = new Date().toISOString()
      // The store's own answers: nothing to send back.
      const shared = await client
        .from(LOOKUPS)
        .update({ store_synced_at: at })
        .is('store_synced_at', null)
        .eq('vendor', 'contact_store')
        .select('id')
      if (shared.error) fail('settle lookups', shared.error)
      // Vendor rows without a single value (not found, error, a search still running).
      const empty = await client
        .from(LOOKUPS)
        .update({ store_synced_at: at })
        .is('store_synced_at', null)
        .in('vendor', ['salesql', 'bettercontact'])
        .eq('emails', '[]')
        .eq('phones', '[]')
        .select('id')
      if (empty.error) fail('settle lookups', empty.error)
      return (shared.data?.length ?? 0) + (empty.data?.length ?? 0)
    },
    async unsyncedLookups(limit) {
      const { data, error } = await client
        .from(LOOKUPS)
        .select(
          'id, linkedin_key, linkedin_url, vendor, emails, phones, updated_at',
        )
        .is('store_synced_at', null)
        .in('vendor', ['salesql', 'bettercontact'])
        .order('updated_at', { ascending: true })
        .limit(limit)
      if (error) fail('read lookups', error)
      return (data ?? []) as LookupSyncRow[]
    },
    async unsyncedFeedback(limit) {
      const { data, error } = await client
        .from(FEEDBACK)
        .select(
          'id, linkedin_key, contact_kind, contact_value, vendor, verdict, reason, updated_at',
        )
        .is('store_synced_at', null)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      if (error) fail('read feedback', error)
      return (data ?? []) as FeedbackSyncRow[]
    },
    async personRows(keys) {
      const rows: PersonSyncRow[] = []
      // A few keys per request keeps the query string short.
      for (let i = 0; i < keys.length; i += 50) {
        const { data, error } = await client
          .from(LOOKUPS)
          .select(
            'linkedin_key, linkedin_url, vendor, status, emails, phones, store_synced_at, updated_at',
          )
          .in('linkedin_key', keys.slice(i, i + 50))
        if (error) fail('read people', error)
        rows.push(...((data ?? []) as PersonSyncRow[]))
      }
      return rows
    },
    markLookup: (id, updatedAt) => markSynced(client, LOOKUPS, id, updatedAt),
    markFeedback: (id, updatedAt) =>
      markSynced(client, FEEDBACK, id, updatedAt),
  }
}
