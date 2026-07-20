import { useQuery } from '@tanstack/react-query'
import { getDashboardById } from '@/services/dashboards.service'
import { QUERY_KEYS } from '@/constants'

export function useDashboard(id: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.dashboard(id ?? ''),
    queryFn: () => getDashboardById(id!),
    enabled: Boolean(id),
  })
}
