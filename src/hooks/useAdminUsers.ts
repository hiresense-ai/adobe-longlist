import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAdminUsers } from '@/services/adminUsers.service'
import { supabase } from '@/supabase/client'
import { QUERY_KEYS } from '@/constants'

/**
 * A one-time (non-realtime) read of the same admin-users list, for callers
 * that just need to populate a picker — e.g. the dashboard assignment
 * dialogs. Deliberately NOT useAdminUsers(): that hook opens a
 * `admin-users-sync` Realtime channel keyed by a fixed name, which is only
 * safe with a single mounted instance (the Users Management page). Multiple
 * concurrent instances — e.g. one per open dashboard dialog — collide on
 * that shared channel name and throw ("cannot add postgres_changes
 * callbacks ... after subscribe()"). Sharing QUERY_KEYS.adminUsers still
 * lets this reuse a cache already warmed by useAdminUsers(), without adding
 * a second subscription.
 */
export function useAssignableUsers(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.adminUsers,
    queryFn: listAdminUsers,
    enabled,
  })
}

/**
 * The Users list, kept honest against changes this tab didn't make.
 *
 * The account set can move underneath an open page in ways a plain cached
 * query never learns about: another admin deleting someone in a second tab,
 * or an operator removing a user straight from the Supabase Dashboard. Three
 * independent signals cover that, deliberately overlapping — each alone has
 * a gap:
 *
 *  - refetchOnMount: 'always' — navigating back to the page is a fresh
 *    read, never a cache replay.
 *  - refetchOnWindowFocus — returning to a tab that sat in the background
 *    re-syncs it. This is what makes the multi-tab case converge.
 *  - Realtime on public.profiles — an INSERT/UPDATE/DELETE from anywhere
 *    (including a Dashboard hard delete, which cascades to profiles)
 *    invalidates this query while the page sits open and focused.
 *
 * staleTime stays 0 so an invalidation actually refetches instead of being
 * served from cache.
 *
 * Realtime is best-effort, not the guarantee: a Dashboard SOFT delete never
 * touches profiles and so emits nothing at all. The server-side
 * reconciliation in admin-users' listUsers is what actually keeps deleted
 * accounts out of the response — these hooks only control how soon the page
 * asks again.
 */
export function useAdminUsers() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const channel = supabase
      .channel('admin-users-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        () => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUsers })
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  return useQuery({
    queryKey: QUERY_KEYS.adminUsers,
    queryFn: listAdminUsers,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}
