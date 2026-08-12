import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createAdminUser,
  deleteAdminUser,
  resetAdminUserPassword,
  setAdminUserDisabled,
  unlockAdminUser,
  updateAdminUser,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from '@/services/adminUsers.service'
import { QUERY_KEYS } from '@/constants'

/**
 * Every mutation here RETURNS its invalidateQueries promise rather than
 * firing it and moving on. React Query keeps the mutation pending until that
 * promise settles, so `await mutateAsync(...)` in a dialog resolves only
 * after the Users list has actually refetched — the dialog then closes onto
 * fresh data instead of briefly showing the row it just deleted.
 *
 * Search and any client-side slicing derive from that same refetched array,
 * so they follow automatically; there is nothing separate to reset.
 */
export function useCreateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAdminUserInput) => createAdminUser(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
  })
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateAdminUserInput) => updateAdminUser(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
  })
}

export function useSetAdminUserDisabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, disabled }: { userId: string; disabled: boolean }) =>
      setAdminUserDisabled(userId, disabled),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
  })
}

export function useDeleteAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => deleteAdminUser(userId),
    // Also invalidates orphanedAuthUsers: this same action is what
    // OrphanedAccountsPanel's "Remove" button calls (deleteUser already
    // treats a no-profile target as unprivileged rather than refusing to
    // act), so a removed orphan needs to disappear from that list too, not
    // just the main Users table.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.orphanedAuthUsers,
        }),
      ]),
  })
}

export function useUnlockAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => unlockAdminUser(userId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
  })
}

export function useResetAdminUserPassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      userId,
      newPassword,
    }: {
      userId: string
      newPassword: string
    }) => resetAdminUserPassword(userId, newPassword),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers }),
  })
}
