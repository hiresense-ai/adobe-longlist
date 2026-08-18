import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  updateDashboard,
  type UpdateDashboardInput,
} from '@/services/dashboardAdmin.service'
import { QUERY_KEYS } from '@/constants'

export function useUpdateDashboard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateDashboardInput) => updateDashboard(input),
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboards })
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.dashboard(dashboard.id),
      })
    },
  })
}
