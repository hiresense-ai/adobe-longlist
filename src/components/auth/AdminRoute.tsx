import { Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { isAtLeastAdmin } from '@/lib/permissions'
import { Forbidden } from '@/pages/Forbidden'

/** Nested inside ProtectedRoute — session is already guaranteed here, only role is checked. */
export function AdminRoute() {
  const { user } = useAuth()

  if (!user || !isAtLeastAdmin(user.role)) {
    return <Forbidden />
  }

  return <Outlet />
}
