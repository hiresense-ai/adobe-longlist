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

/** Resetting SOMEONE ELSE's password to a temporary one.
 *
 * Viewer target:      Admin or Super Admin.
 * Admin target:       Super Admin only.
 * Super Admin target: Super Admin only.
 *
 * Deliberately NOT canActOnAccount: a super_admin target is off-limits for
 * update/disable/delete/unlock, but reset is the one exception. With no
 * email reset flow in this portal, that is the only in-app way to recover a
 * Super Admin account. Mirrored server-side in admin-users' resetPassword. */
export function canResetPassword(
  callerRole: UserRole,
  targetRole: UserRole,
): boolean {
  if (callerRole === 'super_admin') return true
  if (callerRole === 'admin') return targetRole === 'viewer'
  return false
}

/** Changing your OWN password — available to every signed-in role, and
 * always requires the current password. Server-side the target is taken
 * from the JWT, so this is a UI affordance rather than a boundary. */
export function canChangeOwnPassword(_role: UserRole): boolean {
  return true
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

/** Whether a caller may see this user exists at all — the visibility rule
 * behind the Users table, search, filters, and pagination counts. Super
 * Admin accounts are invisible everywhere except to a Super Admin caller
 * (or the account itself); Admin and Viewer accounts are visible to any
 * admin-level caller, same as today. */
export function canViewUser(
  callerRole: UserRole,
  targetRole: UserRole,
): boolean {
  if (targetRole === 'super_admin') return callerRole === 'super_admin'
  return true
}

/** Candidate status/action updates (the per-candidate select/dropdown
 * inside an embedded dashboard) — open to every authenticated role. This is
 * the original design (see the dashboard_status RLS policies' own comment:
 * "every authenticated user can view and update candidate status, that is
 * the core purpose of the portal") and matches dashboard_status_insert/
 * _update, which permit any authenticated caller. Deliberately distinct
 * from canManageDashboards() below — managing the DASHBOARD itself (upload/
 * replace/delete) stays Super Admin only; this only ever covers a
 * candidate's status/action within one. The `role` parameter is unused
 * today but kept so a future narrowing doesn't have to change every call
 * site again. */
export function canUpdateCandidateStatus(_role: UserRole): boolean {
  return true
}

/** Uploading, replacing, and deleting dashboards — Super Admin only.
 * Browsing/opening dashboards stays open to every authenticated role;
 * this gates only the write side (upload dialog, Update Candidates bulk
 * append, delete button). Mirrored server-side by the is_super_admin()
 * RLS policies on public.dashboards and the `dashboards` storage bucket. */
export function canManageDashboards(role: UserRole): boolean {
  return role === 'super_admin'
}

/** Whether a caller may open the "Manage Access" UI on a dashboard card at
 * all. Real authorization (which target role, self-removal) is enforced
 * fresh server-side on every call by the dashboard-assignments Edge
 * Function — this only decides whether the entry point is worth showing.
 * Viewer never gets it. An Admin gets it on every dashboard, matching
 * their dashboard visibility (2026-09-04: Admins see and may manage viewer
 * access on ALL dashboards; the Edge Function no longer assignment-gates
 * an Admin, only limits WHAT they may do — viewer add/remove only). */
export function canManageDashboardAssignments(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin'
}

/** Roles a caller may ADD to a dashboard's assignment list. Mirrors the
 * dashboard-assignments Edge Function: super_admin may assign any role
 * (including another super_admin, e.g. for shared ownership); admin may
 * only add a viewer; viewer may not assign at all. Deliberately separate
 * from assignableRoles() above — that one governs which role a NEW ACCOUNT
 * may be created with, a different question from who may be granted
 * access to an EXISTING dashboard. */
export function assignableDashboardRoles(callerRole: UserRole): UserRole[] {
  if (callerRole === 'super_admin') return ['super_admin', 'admin', 'viewer']
  if (callerRole === 'admin') return ['viewer']
  return []
}

/** Whether a caller may open the Dashboard Analytics view at all. Real
 * authorization (which dashboard) is enforced fresh server-side on every
 * call by the dashboard-analytics Edge Function — this only decides
 * whether the entry point is worth showing. Open to every authenticated
 * role: Super Admin (any dashboard), Admin and Viewer (only dashboards
 * assigned to them — which is exactly the set they can see at all). The
 * `role` parameter is kept so a future narrowing doesn't have to change
 * every call site again, same convention as canUpdateCandidateStatus. */
export function canViewDashboardAnalytics(_role: UserRole): boolean {
  return true
}

/** Whether a caller may open the Edit Dashboard UI at all. Real
 * authorization (which dashboard, which fields) is enforced fresh
 * server-side on every call by the dashboard-edit Edge Function — same
 * split as canManageDashboardAssignments/canViewDashboardAnalytics: this
 * only decides whether the entry point is worth showing. Viewer never gets
 * it. An Admin gets it on every dashboard (2026-09-04: editing follows
 * dashboard visibility — Admins see and may edit the text fields of ALL
 * dashboards; the Edge Function no longer assignment-gates an Admin).
 * Thumbnail controls inside the dialog are gated separately, by
 * canManageDashboards (Super Admin only). */
export function canEditDashboard(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin'
}

/** Whether a caller may CHANGE a requirement's status (Pending → Contacted
 * → In Progress → Completed, plus corrections/reopens) — Super Admin only.
 * The entire lifecycle after creation belongs to Super Admin: Admin and
 * Viewer can never contact, progress, complete, or reopen a requirement.
 * Enforced fresh server-side on every call by the requirements Edge
 * Function; this only decides whether the action buttons are worth
 * showing. */
export function canManageRequirementLifecycle(role: UserRole): boolean {
  return role === 'super_admin'
}

/** Whether a caller may edit a requirement's fields right now. Super Admin
 * edits anything at any stage. Admin edits any requirement, and a Viewer
 * only their own — but both ONLY while it is still 'Pending': from
 * Contacted onward they are read-only. `isOwner` is the caller-vs-creator
 * check, `isPending` the status check; both are re-verified server-side by
 * the requirements Edge Function, so this is a UI affordance, not the
 * boundary. */
export function canEditRequirement(
  role: UserRole,
  { isOwner, isPending }: { isOwner: boolean; isPending: boolean },
): boolean {
  if (role === 'super_admin') return true
  if (!isPending) return false
  if (role === 'admin') return true
  return isOwner
}

/** Deleting requirements — Super Admin only, the same split as dashboard
 * deletion. Deliberately NOT extended to Admin/Viewer: allowing a creator
 * to delete would let them sidestep the post-Contacted read-only lock by
 * deleting and recreating. Mirrored server-side by the requirements Edge
 * Function. */
export function canDeleteRequirements(role: UserRole): boolean {
  return role === 'super_admin'
}

export function roleLabel(role: UserRole): string {
  if (role === 'super_admin') return 'Super Admin'
  if (role === 'admin') return 'Admin'
  return 'Viewer'
}
