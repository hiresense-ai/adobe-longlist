import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { Loader2 } from 'lucide-react'

export function ProtectedRoute() {
  const { session, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <Loader2 className="text-primary size-8 animate-spin" />
      </div>
    )
  }

  if (!session) {
    return <Navigate to={ROUTES.login} state={{ from: location }} replace />
  }

  return <Outlet />
}
