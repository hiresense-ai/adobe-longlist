import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createRequirement,
  deleteRequirement,
  listRequirements,
  updateRequirement,
  updateRequirementStatus,
  type CreateRequirementInput,
  type UpdateRequirementInput,
  type UpdateRequirementStatusInput,
} from '@/services/requirements.service'
import { QUERY_KEYS } from '@/constants'

/** The role/status-shaped requirements list — authorization and field
 * visibility are decided fresh server-side on every call by the
 * requirements Edge Function; this hook is just when to ask. */
export function useRequirements() {
  return useQuery({
    queryKey: QUERY_KEYS.requirements,
    queryFn: listRequirements,
  })
}

function useInvalidatingMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.requirements })
    },
  })
}

export function useCreateRequirement() {
  return useInvalidatingMutation((input: CreateRequirementInput) =>
    createRequirement(input),
  )
}

export function useUpdateRequirement() {
  return useInvalidatingMutation((input: UpdateRequirementInput) =>
    updateRequirement(input),
  )
}

export function useUpdateRequirementStatus() {
  return useInvalidatingMutation((input: UpdateRequirementStatusInput) =>
    updateRequirementStatus(input),
  )
}

export function useDeleteRequirement() {
  return useInvalidatingMutation((requirementId: string) =>
    deleteRequirement(requirementId),
  )
}
