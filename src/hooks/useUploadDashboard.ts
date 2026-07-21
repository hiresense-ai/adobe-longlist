import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  uploadDashboard,
  type UploadDashboardInput,
} from '@/services/dashboardAdmin.service'
import { QUERY_KEYS } from '@/constants'

export function useUploadDashboard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UploadDashboardInput) => uploadDashboard(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboards })
    },
  })
}
