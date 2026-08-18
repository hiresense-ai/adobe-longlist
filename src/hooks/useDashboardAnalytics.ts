import { useQuery } from '@tanstack/react-query'
import { getDashboardAnalytics } from '@/services/dashboardAnalytics.service'
import { QUERY_KEYS } from '@/constants'

/** Analytics for one dashboard. Only fetched while the Analytics dialog is
 * actually open (`enabled`), same pattern as useDashboardAssignments —
 * authorization is re-checked server-side on every call by the
 * dashboard-analytics Edge Function, this is just when to ask. Refetches on
 * every open (React Query default staleTime keeps rapid re-opens cheap)
 * rather than living in some longer-lived cache, so a candidate action
 * changed elsewhere shows up next time the dialog is opened. */
export function useDashboardAnalytics(dashboardId: string, enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.dashboardAnalytics(dashboardId),
    queryFn: () => getDashboardAnalytics(dashboardId),
    enabled,
  })
}
