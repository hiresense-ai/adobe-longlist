import { Link } from 'react-router-dom'
import { ArrowLeft, ShieldQuestion } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ROUTES, APP_NAME } from '@/constants'

/**
 * Deliberately not a form.
 *
 * This is an internal enterprise portal with no outbound email, no OTP, and
 * no password reset links — accounts are provisioned and recovered by an
 * administrator, who resets the password and hands over a temporary one out
 * of band. The route is kept (rather than deleted) so the "Forgot password?"
 * link on the sign-in page, and any existing bookmark, lands somewhere that
 * explains what to do instead of a 404.
 */
export function ForgotPassword() {
  return (
    <div className="bg-muted/40 flex min-h-svh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground shadow-soft flex size-12 items-center justify-center rounded-2xl text-2xl font-bold">
            A
          </div>
          <div>
            <h1 className="text-foreground text-xl font-semibold">
              {APP_NAME}
            </h1>
            <p className="text-muted-foreground text-sm">Password help</p>
          </div>
        </div>

        <div className="border-border bg-card shadow-soft rounded-2xl border p-6 text-center sm:p-8">
          <div className="bg-muted text-muted-foreground mx-auto mb-4 flex size-11 items-center justify-center rounded-full">
            <ShieldQuestion className="size-5" />
          </div>
          <p className="text-foreground text-sm font-medium">
            Please contact your administrator to reset your password.
          </p>
          <p className="text-muted-foreground mt-2 text-sm">
            They will set a temporary password for you. You'll be asked to
            choose your own the next time you sign in.
          </p>

          <Button asChild variant="outline" className="mt-6 w-full">
            <Link to={ROUTES.login}>
              <ArrowLeft className="size-4" />
              Back to sign in
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
