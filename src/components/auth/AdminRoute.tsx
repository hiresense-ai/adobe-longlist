import { Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Forbidden } from '@/pages/Forbidden'

/** Nested inside ProtectedRoute — session is already guaranteed here, only role is checked. */
export function AdminRoute() {
  const { user } = useAuth()

  if (user?.role !== 'admin') {
    return <Forbidden />
  }

  return <Outlet />
}
