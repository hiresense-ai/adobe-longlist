import { invokeEdgeFunction } from '@/lib/edgeFunction'
import type { AdminUserRow, UserRole } from '@/types'

const FUNCTION_NAME = 'admin-users'

function invoke<T>(body: Record<string, unknown>): Promise<T> {
  return invokeEdgeFunction<T>(FUNCTION_NAME, body)
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const result = await invoke<{ users: AdminUserRow[] }>({ action: 'list' })
  return result.users
}

/** A live auth.users account with no profiles row behind it — invisible in
 * the normal Users list (see listAdminUsers/listUsers) because it has no
 * role and can't sign in, but still occupying its email. Super Admin only —
 * see admin-users' listOrphans. */
export interface OrphanedAuthUser {
  id: string
  email: string
  createdAt: string
  lastSignInAt: string | null
}

export async function listOrphanedAuthUsers(): Promise<OrphanedAuthUser[]> {
  const result = await invoke<{ orphans: OrphanedAuthUser[] }>({
    action: 'listOrphans',
  })
  return result.orphans
}

export interface CreateAdminUserInput {
  firstName: string
  lastName: string
  email: string
  password: string
  role: UserRole
}

export async function createAdminUser(
  input: CreateAdminUserInput,
): Promise<{ id: string }> {
  return invoke({ action: 'create', payload: input })
}

export interface UpdateAdminUserInput {
  userId: string
  name?: string
  email?: string
  role?: UserRole
}

export async function updateAdminUser(
  input: UpdateAdminUserInput,
): Promise<void> {
  await invoke({ action: 'update', payload: input })
}

export async function setAdminUserDisabled(
  userId: string,
  disabled: boolean,
): Promise<void> {
  await invoke({ action: 'setDisabled', payload: { userId, disabled } })
}

/** Outcome of a delete, so the UI can tell "I removed this account" from
 * "this account was already gone" and word the confirmation accordingly. */
export interface DeleteAdminUserResult {
  /** The account had already been removed elsewhere (e.g. straight from the
   * Supabase Dashboard) before this click landed. */
  alreadyDeleted?: boolean
  /** A profile row was left behind without a live auth user and got cleaned
   * up as part of this delete. */
  orphanCleaned?: boolean
}

export async function deleteAdminUser(
  userId: string,
): Promise<DeleteAdminUserResult> {
  return invoke<DeleteAdminUserResult>({
    action: 'delete',
    payload: { userId },
  })
}

export async function unlockAdminUser(userId: string): Promise<void> {
  await invoke({ action: 'unlock', payload: { userId } })
}

export async function resetAdminUserPassword(
  userId: string,
  newPassword: string,
): Promise<void> {
  await invoke({ action: 'resetPassword', payload: { userId, newPassword } })
}

export function filterAdminUsers(
  users: AdminUserRow[],
  query: string,
): AdminUserRow[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return users

  return users.filter((user) =>
    [user.name, user.email]
      .filter(Boolean)
      .some((field) => field!.toLowerCase().includes(normalized)),
  )
}
