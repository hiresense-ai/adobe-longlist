import type { UserRole } from '@/types'

/**
 * Single source of truth for the account-security role hierarchy
 * (super_admin > admin > viewer). Mirrors the authorization enforced
 * server-side in supabase/functions/admin-users/index.ts — every rule here
 * has a matching check there, since a hidden button is only a UX nicety,
 * not a security boundary. Keep the two in sync if either changes.
 */

/** General "has admin-level access" check — dashboard upload/delete, the
 * Users nav link, and anywhere else that was previously `role === 'admin'`
 * before super_admin existed. super_admin is a strict superset of admin. */
export function isAtLeastAdmin(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin'
}

/** Roles that can be granted through the app's own Create/Edit user UI.
 * super_admin is intentionally excluded — that role is assigned by hand,
 * outside the application (see the account-security migration). */
export function assignableRoles(callerRole: UserRole): UserRole[] {
  if (callerRole === 'super_admin') return ['admin', 'viewer']
  if (callerRole === 'admin') return ['viewer']
  return []
}

export function canAssignRole(
  callerRole: UserRole,
  targetRole: UserRole,
): boolean {
  return assignableRoles(callerRole).includes(targetRole)
}

export function canCreateUsers(callerRole: UserRole): boolean {
  return assignableRoles(callerRole).length > 0
}

/** The shared hierarchy rule behind unlock, disable, delete, and role
 * changes: a Viewer target is fair game for an Admin or a Super Admin; an
 * Admin target requires a Super Admin; a Super Admin target is off-limits
 * to everyone through the app (see the module comment). */
function canActOnAccount(callerRole: UserRole, targetRole: UserRole): boolean {
  if (targetRole === 'super_admin') return false
  if (targetRole === 'admin') return callerRole === 'super_admin'
  return callerRole === 'admin' || callerRole === 'super_admin'
}

/** Viewer accounts: unlockable by an Admin or a Super Admin.
 * Admin accounts: unlockable only by a Super Admin.
 * Super Admin accounts: never locked, so never unlockable. */
export function canUnlock(callerRole: UserRole, targetRole: UserRole): boolean {
  return canActOnAccount(callerRole, targetRole)
}

/** Only a Super Admin can reset another account's password. */
export function canResetPassword(callerRole: UserRole): boolean {
  return callerRole === 'super_admin'
}

/** An Admin may disable/delete a Viewer but not a fellow Admin — the same
 * "can't act on a peer or above" rule as unlock. */
export function canDisableOrDelete(
  callerRole: UserRole,
  targetRole: UserRole,
): boolean {
  return canActOnAccount(callerRole, targetRole)
}

/** Whether the role field itself may be changed for this target at all —
 * checked before offering any new value. Not implied by canAssignRole: an
 * Admin can assign 'viewer' in general, but not take it away from a fellow
 * Admin, since that's a demotion of a peer, not a viewer being managed. */
export function canEditRole(
  callerRole: UserRole,
  targetRole: UserRole,
): boolean {
  return canActOnAccount(callerRole, targetRole)
}

export function roleLabel(role: UserRole): string {
  if (role === 'super_admin') return 'Super Admin'
  if (role === 'admin') return 'Admin'
  return 'Viewer'
}
