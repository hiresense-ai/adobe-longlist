import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { WORKSPACE } from '@/config/workspaces'
import { canViewJdAnalytics } from '@/lib/permissions'

// The profile (and so the role) loads just after the session is set; if it
// never arrives, don't hang — fall back to Dashboards.
const PROFILE_WAIT_MS = 5000

/**
 * ROUTES.start: waits for the signed-in user's role, then redirects —
 * JD Analytics for Admin / Super Admin, Dashboards for Viewers (who can't
 * open JD Analytics). Rendered inside ProtectedRoute, so a session exists.
 */
export function LandingRedirect() {
  const { user } = useAuth()
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    if (user) return
    const timer = setTimeout(() => setGaveUp(true), PROFILE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [user])

  if (!WORKSPACE.landOnJdAnalytics) return <Navigate to={ROUTES.home} replace />
  if (user) {
    return (
      <Navigate
        to={canViewJdAnalytics(user.role) ? ROUTES.jdAnalytics : ROUTES.home}
        replace
      />
    )
  }
  if (gaveUp) return <Navigate to={ROUTES.home} replace />

  return (
    <div className="bg-background flex min-h-svh items-center justify-center">
      <Loader2 className="text-primary size-8 animate-spin" />
    </div>
  )
}
