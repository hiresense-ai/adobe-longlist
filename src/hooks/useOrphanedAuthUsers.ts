import { useQuery } from '@tanstack/react-query'
import { listOrphanedAuthUsers } from '@/services/adminUsers.service'
import { QUERY_KEYS } from '@/constants'

/**
 * Accounts that exist in Supabase Auth but have no profiles row — see
 * admin-users' listOrphans for how/why this happens (never through this
 * app's own create/delete flows; only an out-of-band profiles deletion,
 * e.g. via the Supabase Dashboard). Super Admin only, both server-side
 * (listOrphans 403s anyone else) and here (`enabled` skips the call
 * entirely for a caller who'd just get a 403 back).
 *
 * No realtime subscription: unlike the main Users list, this is a rare,
 * admin-initiated lookup rather than something that needs to stay live
 * while the page sits open.
 */
export function useOrphanedAuthUsers(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.orphanedAuthUsers,
    queryFn: listOrphanedAuthUsers,
    enabled,
    staleTime: 30_000,
  })
}
