import type { Workspace, WorkspaceId } from '@/config/workspaces'

/**
 * Which Supabase project a workspace talks to, and the fail-closed checks
 * that refuse a wrong or missing one. Only PUBLIC values ever reach the
 * browser (project URL + anon key); service-role keys live solely in each
 * project's own Edge Function environment.
 *
 *   Adobe  VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY            (unchanged)
 *   Lyca   VITE_LYCA_SUPABASE_URL / VITE_LYCA_SUPABASE_ANON_KEY
 */

/** Adobe's production project. Not a secret — it ships in every Adobe bundle. */
export const ADOBE_PRODUCTION_SUPABASE_URL =
  'https://lomiqhcbjivdgophreiw.supabase.co'

export interface SupabaseTarget {
  url: string
  anonKey: string
  isLocal: boolean
}

export type SupabaseTargetResult =
  { ok: true; target: SupabaseTarget } | { ok: false; reason: string }

interface RawConfig {
  url: string | undefined
  anonKey: string | undefined
}

function envConfig(id: WorkspaceId): RawConfig {
  // Literal references — Vite inlines each VITE_* value at build time.
  return id === 'adobe'
    ? {
        url: import.meta.env.VITE_SUPABASE_URL,
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      }
    : {
        url: import.meta.env.VITE_LYCA_SUPABASE_URL,
        anonKey: import.meta.env.VITE_LYCA_SUPABASE_ANON_KEY,
      }
}

const normalizeUrl = (url: string) =>
  url.trim().replace(/\/+$/, '').toLowerCase()

export const isLocalSupabaseUrl = (url: string) =>
  /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url.trim())

/**
 * Pure decision (no side effects), so it can be exercised directly:
 * `configs` and `isDev` default to this build's real values.
 */
export function resolveSupabaseTarget(
  workspace: Workspace,
  isDev: boolean = import.meta.env.DEV,
  configs: Record<WorkspaceId, RawConfig> = {
    adobe: envConfig('adobe'),
    lyca: envConfig('lyca'),
  },
): SupabaseTargetResult {
  const name = workspace.branding.appName
  const own = configs[workspace.id]
  const fail = (reason: string): SupabaseTargetResult => ({
    ok: false,
    reason,
  })

  if (!own.url?.trim() || !own.anonKey?.trim()) {
    return fail(`${name} is not configured for this environment.`)
  }
  const url = own.url.trim()
  const anonKey = own.anonKey.trim()
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    return fail(`${name} has an invalid backend URL.`)
  }

  // A newer workspace may never share another workspace's project or key —
  // that would put one client's pages on another client's backend. Checked
  // for the non-default workspaces only: Adobe's startup depends on Adobe's
  // own configuration alone, exactly as before, so a mistake in Lyca's
  // settings can only ever take Lyca down, never Adobe.
  if (workspace.id !== 'adobe') {
    for (const other of Object.keys(configs) as WorkspaceId[]) {
      if (other === workspace.id) continue
      const theirs = configs[other]
      if (theirs.url && normalizeUrl(theirs.url) === normalizeUrl(url)) {
        return fail(`${name} is configured with another client's backend.`)
      }
      if (theirs.anonKey && theirs.anonKey.trim() === anonKey) {
        return fail(`${name} is configured with another client's key.`)
      }
    }
    if (normalizeUrl(url) === normalizeUrl(ADOBE_PRODUCTION_SUPABASE_URL)) {
      return fail(`${name} is configured with Adobe's production backend.`)
    }
  }

  const local = isLocalSupabaseUrl(url)
  if (isDev) {
    // Local development never runs against a production project — Adobe's
    // long-standing guard — and the newer workspaces only ever run against
    // their own local stack.
    if (normalizeUrl(url) === normalizeUrl(ADOBE_PRODUCTION_SUPABASE_URL)) {
      return fail(
        'REFUSING TO START: local development is pointed at the PRODUCTION ' +
          'Supabase project. Point .env.local at the local stack instead ' +
          '(npm run local:start, then copy the API URL and anon key from ' +
          '`npm run local:status` — see docs/ENVIRONMENTS.md). Never develop ' +
          'against production.',
      )
    }
    if (workspace.id !== 'adobe' && !local) {
      return fail(
        `${name}: local development must use its local stack ` +
          '(npm run lyca:start, then `npm run lyca:env` for .env.local).',
      )
    }
  } else if (workspace.id !== 'adobe' && !url.startsWith('https://')) {
    return fail(`${name} must use an https backend URL.`)
  }

  return { ok: true, target: { url, anonKey, isLocal: local } }
}
