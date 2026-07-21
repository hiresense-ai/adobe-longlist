import { supabase } from '@/supabase/client'
import type { AdminUserRow, UserRole } from '@/types'

const FUNCTION_NAME = 'admin-users'

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body,
  })

  if (error) {
    // Supabase wraps non-2xx responses in a FunctionsHttpError; the actual
    // { error: string } payload is on error.context, not error.message.
    const context = (error as { context?: Response }).context
    if (context) {
      try {
        const parsed = await context.clone().json()
        if (parsed?.error) throw new Error(parsed.error)
      } catch {
        // fall through to the generic error below
      }
    }
    throw new Error(error.message)
  }

  return data as T
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const result = await invoke<{ users: AdminUserRow[] }>({ action: 'list' })
  return result.users
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

export async function deleteAdminUser(userId: string): Promise<void> {
  await invoke({ action: 'delete', payload: { userId } })
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
