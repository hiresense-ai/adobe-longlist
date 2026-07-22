import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  updateDashboardCandidates,
  type UpdateDashboardCandidatesInput,
} from '@/services/dashboardAdmin.service'
import { QUERY_KEYS } from '@/constants'

export function useUpdateDashboardCandidates() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateDashboardCandidatesInput) =>
      updateDashboardCandidates(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboards })
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.dashboard(result.dashboard.id),
      })
    },
  })
}
