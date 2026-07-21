import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteDashboard } from '@/services/dashboardAdmin.service'
import { QUERY_KEYS } from '@/constants'
import type { Dashboard } from '@/types'

export function useDeleteDashboard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (
      dashboard: Pick<Dashboard, 'id' | 'storage_path' | 'thumbnail'>,
    ) => deleteDashboard(dashboard),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboards })
    },
  })
}
