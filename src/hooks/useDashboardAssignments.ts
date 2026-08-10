import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  assignDashboardUser,
  listDashboardAssignments,
  unassignDashboardUser,
} from '@/services/dashboardAssignments.service'
import { QUERY_KEYS } from '@/constants'

/** The current assignee roster for one dashboard. Only fetched while the
 * Manage Access dialog is actually open (`enabled`) — every other caller of
 * this data (visibility itself) goes through RLS, not this Edge Function. */
export function useDashboardAssignments(dashboardId: string, enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.dashboardAssignments(dashboardId),
    queryFn: () => listDashboardAssignments(dashboardId),
    enabled,
  })
}

export function useAssignDashboardUser(dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => assignDashboardUser(dashboardId, userId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.dashboardAssignments(dashboardId),
      }),
  })
}

export function useUnassignDashboardUser(dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => unassignDashboardUser(dashboardId, userId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.dashboardAssignments(dashboardId),
      }),
  })
}
