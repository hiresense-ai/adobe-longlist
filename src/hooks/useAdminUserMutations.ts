import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createAdminUser,
  deleteAdminUser,
  setAdminUserDisabled,
  updateAdminUser,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from '@/services/adminUsers.service'
import { QUERY_KEYS } from '@/constants'

export function useCreateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAdminUserInput) => createAdminUser(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers })
    },
  })
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateAdminUserInput) => updateAdminUser(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers })
    },
  })
}

export function useSetAdminUserDisabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, disabled }: { userId: string; disabled: boolean }) =>
      setAdminUserDisabled(userId, disabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers })
    },
  })
}

export function useDeleteAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => deleteAdminUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers })
    },
  })
}
