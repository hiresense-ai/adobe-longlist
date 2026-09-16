import { useQuery, keepPreviousData } from '@tanstack/react-query'
import {
  listActionLogs,
  type ListActionLogsParams,
} from '@/services/actionLogs.service'
import { QUERY_KEYS } from '@/constants'

/**
 * One page of the Action Logs table, server-filtered/sorted/paginated (see
 * the action-logs Edge Function's own module comment for why this endpoint,
 * uniquely in this app, doesn't just fetch everything). keepPreviousData
 * keeps the current page's rows on screen while a new page/filter/sort is
 * loading, instead of flashing to a skeleton on every change — this page
 * is the one place in the app where filters/pagination hit the network on
 * every change rather than re-slicing an already-loaded set.
 */
export function useActionLogs(params: ListActionLogsParams) {
  return useQuery({
    queryKey: QUERY_KEYS.actionLogs(params),
    queryFn: () => listActionLogs(params),
    placeholderData: keepPreviousData,
  })
}
