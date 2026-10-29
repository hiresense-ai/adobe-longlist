// contact-store-sync (HIR-526, Lyca): sends the shared contact store every
// revealed contact and every 👍/👎 it does not have yet.
//
// candidate-contacts sends each one in the background right after it is
// saved; when that send fails (the store down, slow or refusing), the row
// stays unsynced (store_synced_at null). This function, called every 10
// minutes by a pg_cron + pg_net job on the Lyca project, sends those rows,
// oldest first, lookups before feedback, at most SYNC_MAX_ROWS rows and
// SYNC_BUDGET_MS per run, and marks each row as it lands. The rules are in
// ../candidate-contacts/store-sync.ts.
//
// Call:  POST, header x-contact-store-sync-secret: <CONTACT_STORE_SYNC_SECRET>
//        verify_jwt is off (supabase/config.toml): the secret is the only key.
// Answer: counts only, e.g. {"status":"ok","lookups":{"sent":3,...},...};
//         {"status":"skipped","reason":"store_not_ready"} while GET /ready is
//         not 200 or CONTACT_ENRICHMENT_URL / _API_KEY are unset (nothing is
//         read or sent then). 401 for a wrong secret; 503 while
//         CONTACT_STORE_SYNC_SECRET is unset or shorter than 32 characters.
//
// Settings (function secrets): CONTACT_STORE_SYNC_SECRET, plus the store's
// CONTACT_ENRICHMENT_URL and CONTACT_ENRICHMENT_API_KEY that candidate-contacts
// already uses. Logs never carry an email, phone or LinkedIn URL.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { supabaseSyncDb } from '../candidate-contacts/store-sync-db.ts'
import { handleSync } from './handler.ts'

Deno.serve((req: Request) =>
  handleSync(req, {
    secret: Deno.env.get('CONTACT_STORE_SYNC_SECRET'),
    db: () =>
      supabaseSyncDb(
        createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          { auth: { persistSession: false } },
        ),
      ),
  }),
)
