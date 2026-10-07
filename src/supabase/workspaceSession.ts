import {
  WORKSPACES,
  type Workspace,
  type WorkspaceId,
} from '@/config/workspaces'
import { workspaceSupabaseUrl } from '@/supabase/workspaceConfig'

/**
 * One signed-in workspace per browser.
 *
 * Adobe and Lyca are separate Supabase projects with separate sessions, so a
 * browser could otherwise hold both at once — and simply editing the URL
 * (removing /lyca) would land in the other workspace still signed in. To
 * avoid that, the workspace someone signs in to becomes the browser's
 * ACTIVE workspace: signing in removes every other workspace's stored
 * session, and a page that loads for a workspace that isn't the active one
 * discards its own leftover session before its Supabase client starts, so
 * it shows its sign-in page.
 *
 * Browser-local only — it never contacts the other project (the per-
 * workspace CSP forbids that anyway) and it is not a security boundary: the
 * projects already reject each other's tokens.
 */
const ACTIVE_WORKSPACE_KEY = 'longlist.activeWorkspace'

/** The localStorage key supabase-js keeps a workspace's session under. */
export function authStorageKey(workspace: Workspace): string | null {
  if (workspace.authStorageKey) return workspace.authStorageKey
  // supabase-js's default: sb-<first label of the project host>-auth-token.
  const url = workspaceSupabaseUrl(workspace.id)
  if (!url) return null
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
  } catch {
    return null
  }
}

function removeStoredSession(workspace: Workspace) {
  const key = authStorageKey(workspace)
  if (!key) return
  // The session itself plus any companion entries supabase-js keeps beside
  // it (e.g. "<key>-user", "<key>-code-verifier").
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const stored = window.localStorage.key(i)
    if (stored && (stored === key || stored.startsWith(`${key}-`))) {
      window.localStorage.removeItem(stored)
    }
  }
}

function hasStoredSession(workspace: Workspace): boolean {
  const key = authStorageKey(workspace)
  return !!key && window.localStorage.getItem(key) !== null
}

/** Page load, before this workspace's Supabase client is created. */
export function discardSessionIfNotActive(current: Workspace) {
  try {
    const active = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY)
    if (!active) {
      // Browsers signed in before this marker existed: the first workspace
      // opened with a session keeps it and becomes the active one, so a
      // browser already holding both sessions gets down to one right away.
      // Nothing is removed here — single-workspace users see no change.
      if (hasStoredSession(current)) {
        window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, current.id)
      }
    } else if (active !== current.id) {
      removeStoredSession(current)
    }
  } catch {
    // Storage unavailable — nothing stored to discard.
  }
}

/** After a successful sign-in to `current`: sign every other one out. */
export function makeActiveWorkspace(current: Workspace) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, current.id)
    for (const id of Object.keys(WORKSPACES) as WorkspaceId[]) {
      if (id !== current.id) removeStoredSession(WORKSPACES[id])
    }
  } catch {
    // Storage unavailable — sessions can't persist across workspaces either.
  }
}
