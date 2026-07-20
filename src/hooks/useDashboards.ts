import { useQuery } from '@tanstack/react-query'
import { listDashboards } from '@/services/dashboards.service'
import { QUERY_KEYS } from '@/constants'

export function useDashboards() {
  return useQuery({
    queryKey: QUERY_KEYS.dashboards,
    queryFn: listDashboards,
  })
}
