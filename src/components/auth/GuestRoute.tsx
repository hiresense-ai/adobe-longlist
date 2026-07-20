import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { Loader2 } from 'lucide-react'

/** Redirects already-authenticated users away from guest-only pages (login, forgot password). */
export function GuestRoute() {
  const { session, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <Loader2 className="text-primary size-8 animate-spin" />
      </div>
    )
  }

  if (session) {
    return <Navigate to={ROUTES.home} replace />
  }

  return <Outlet />
}
