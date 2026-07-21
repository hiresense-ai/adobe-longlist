import { useQuery } from '@tanstack/react-query'
import { listAdminUsers } from '@/services/adminUsers.service'
import { QUERY_KEYS } from '@/constants'

export function useAdminUsers() {
  return useQuery({
    queryKey: QUERY_KEYS.adminUsers,
    queryFn: listAdminUsers,
  })
}
