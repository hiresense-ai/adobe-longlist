import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { Loader2 } from 'lucide-react'

export function ProtectedRoute() {
  const { session, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <Loader2 className="text-primary size-8 animate-spin" />
      </div>
    )
  }

  // Deliberately no `state={{ from: location }}`: login always lands on the
  // Dashboard (see Login.tsx), so there's no redirect-back consumer for it.
  if (!session) {
    return <Navigate to={ROUTES.login} replace />
  }

  return <Outlet />
}
