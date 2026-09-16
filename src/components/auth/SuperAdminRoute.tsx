import { Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Forbidden } from '@/pages/Forbidden'

/** Nested inside ProtectedRoute — session is already guaranteed here, only
 * role is checked. Narrower than AdminRoute (which admits Admin too): pages
 * behind this guard are Super-Admin-only, e.g. Action Logs. A manual visit
 * to the URL by an Admin or Viewer gets the same Forbidden page AdminRoute
 * shows — the backend enforces the real boundary regardless of this check
 * (see canViewActionLogs's doc comment). */
export function SuperAdminRoute() {
  const { user } = useAuth()

  if (!user || user.role !== 'super_admin') {
    return <Forbidden />
  }

  return <Outlet />
}
