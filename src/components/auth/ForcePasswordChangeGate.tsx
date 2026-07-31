import { Outlet } from 'react-router-dom'
import { KeyRound } from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm'
import { APP_NAME } from '@/constants'

/**
 * Blocks the entire authenticated app until a user whose password was reset
 * by an administrator has chosen their own.
 *
 * Placed inside ProtectedRoute and OUTSIDE AppLayout, so there is no navbar,
 * no dashboards, and no Users page to reach around it — the only rendered
 * affordances are the change-password form and sign out. It replaces the
 * <Outlet/> rather than redirecting to a dedicated route, so there is no URL
 * a user could simply navigate away from.
 *
 * This is a UX guarantee, not the security boundary: profiles
 * .force_password_change is service-role-only (guard_profile_lock_columns),
 * and every privileged action is independently authorized server-side
 * regardless of this gate.
 */
export function ForcePasswordChangeGate() {
  const { user, logout } = useAuth()

  if (!user?.forcePasswordChange) return <Outlet />

  return (
    <div className="bg-muted/40 flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground shadow-soft flex size-12 items-center justify-center rounded-2xl">
            <KeyRound className="size-5" />
          </div>
          <div>
            <h1 className="text-foreground text-xl font-semibold">
              Choose a new password
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              An administrator set a temporary password for your {APP_NAME}{' '}
              account. Pick your own to continue.
            </p>
          </div>
        </div>

        <div className="border-border bg-card shadow-soft rounded-2xl border p-6 sm:p-8">
          <ChangePasswordForm
            currentPasswordLabel="Temporary password"
            submitLabel="Set password and continue"
            onSignOut={logout}
          />
        </div>
      </div>
    </div>
  )
}
