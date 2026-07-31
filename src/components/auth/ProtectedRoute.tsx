import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { Loader2 } from 'lucide-react'

export function ProtectedRoute() {
  const { session, user, isLoading } = useAuth()

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

  // `session` and `user` are set by two separate calls inside
  // AuthContext's onAuthStateChange handler, with a network round-trip
  // (the profile fetch) between them — `session` updates first, `user`
  // only once that fetch resolves. `isLoading` alone doesn't cover this
  // gap: it was already `false` from sitting on a public page like
  // /login, and nothing resets it back to `true` for a same-tab sign-in
  // (only a fresh page load goes through the `isLoading: true` initial
  // state). GuestRoute redirects to here the instant `session` goes
  // truthy, so for a real, measured window after sign-in this route saw
  // session != null while user was still null/stale and rendered its
  // children anyway — letting a user land on the Dashboard (or whatever
  // painted during that gap) before ForcePasswordChangeGate, one level
  // down, had the data to block them. Waiting for the ids to actually
  // match closes that window without depending on any assumption about
  // exactly how fast the profile fetch resolves relative to the redirect.
  if (!user || user.id !== session.user.id) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <Loader2 className="text-primary size-8 animate-spin" />
      </div>
    )
  }

  return <Outlet />
}
