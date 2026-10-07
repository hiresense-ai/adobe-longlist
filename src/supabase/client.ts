import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types'
import { WORKSPACE } from '@/config/workspaces'
import { resolveSupabaseTarget } from '@/supabase/workspaceConfig'
import { discardSessionIfNotActive } from '@/supabase/workspaceSession'

// ---------------------------------------------------------------------------
// The ONE Supabase client of this page load — for this page's workspace
// only (src/config/workspaces.ts: /lyca/... is Lyca Mobile, everything else
// Adobe). It is created once and never re-pointed: there is no code path
// that switches a running page to another project, and moving between
// workspaces is always a full page load.
//
// Environment isolation guard (resolveSupabaseTarget): a missing or wrong
// configuration — a workspace sharing another client's project or key,
// Lyca pointed at Adobe's production project, or local development pointed
// at production — never yields a client. main.tsx renders a "workspace
// unavailable" screen instead of the app, and the placeholder below throws
// on any use, so nothing can silently fall back to another backend.
// ---------------------------------------------------------------------------
const resolved = resolveSupabaseTarget(WORKSPACE)

/** Why this page's workspace can't start, or null when it can. */
export const WORKSPACE_CONFIG_ERROR: string | null = resolved.ok
  ? null
  : resolved.reason

/** True when the app is talking to a Supabase stack on this machine. */
export const IS_LOCAL_BACKEND = resolved.ok && resolved.target.isLocal

/** This workspace's project URL (for diagnostics/display only). */
export const SUPABASE_URL = resolved.ok ? resolved.target.url : null

if (import.meta.env.DEV && resolved.ok) {
  console.info(
    `[longlist:${WORKSPACE.id}] Environment: ${IS_LOCAL_BACKEND ? 'LOCAL' : 'REMOTE'} — Supabase: ${resolved.target.url}`,
  )
}

function unavailableClient(reason: string): SupabaseClient<Database> {
  return new Proxy({} as SupabaseClient<Database>, {
    get() {
      throw new Error(`Supabase client unavailable: ${reason}`)
    },
  })
}

// One signed-in workspace per browser: if another workspace is the active
// one, this page's leftover session is dropped before the client reads it,
// so this workspace opens on its sign-in page (src/supabase/workspaceSession.ts).
if (resolved.ok) discardSessionIfNotActive(WORKSPACE)

export const supabase: SupabaseClient<Database> = resolved.ok
  ? createClient<Database>(resolved.target.url, resolved.target.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Only set when the workspace has its own key. Passing
        // `storageKey: undefined` is NOT the same as omitting it: supabase-js
        // spreads these options over its defaults, so an explicit undefined
        // would replace Adobe's default key and sign every existing Adobe
        // session out. Omitted for Adobe = exactly the options it always had.
        ...(WORKSPACE.authStorageKey
          ? { storageKey: WORKSPACE.authStorageKey }
          : {}),
      },
    })
  : unavailableClient(resolved.reason)
