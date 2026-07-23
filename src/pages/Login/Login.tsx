import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Lock, Mail } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import loginHeroBg from '@/assets/login-hero-bg.jpg'
import hireSenseLogo from '@/assets/hiresense-logo.png'

// Deliberately not tied to the current password-creation policy: existing
// accounts may have passwords set under an older, shorter policy, and this
// form must keep letting them sign in with whatever their real password is.
const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormValues = z.infer<typeof loginSchema>

// This page always renders in its own fixed dark brand treatment,
// independent of the app's light/dark theme toggle — matching the
// enterprise hero design it was built from and the same reasoning
// products like Adobe/Atlassian/Vercel use for a signed-out splash: it's
// brand real estate that comes before the user has any in-app theme
// preference applied.
export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: LoginFormValues) {
    setIsSubmitting(true)
    try {
      await login(values.email, values.password)
      toast.success('Welcome back!')
      // Always land on the Dashboard after login — never restore whatever
      // page ProtectedRoute's redirect-with-state happened to carry along
      // (e.g. a page open before a session expired or before logging out).
      navigate(ROUTES.home, { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to sign in'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-svh flex-col bg-zinc-950 lg:flex-row">
      {/* Hero — the reference design's own artwork (Adobe mark, headline,
          tagline, and decorative chart previews are all baked into this
          image), used exactly as provided rather than recreated. Purely
          decorative/hidden below 1024px — the card on the right carries no
          duplicate branding, just the sign-in form itself. */}
      <div
        aria-hidden="true"
        className="animate-in fade-in hidden bg-cover bg-center bg-no-repeat duration-700 motion-reduce:animate-none lg:block lg:w-[58%] lg:shrink-0"
        style={{ backgroundImage: `url(${loginHeroBg})` }}
      />

      {/* Login card */}
      <div className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-[440px] duration-500 motion-reduce:animate-none">
          <p className="mb-6 text-center text-sm text-white/60">
            Sign in to access your hiring dashboards
          </p>

          <div className="rounded-[22px] border border-white/10 bg-white/[0.04] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5"
                noValidate
              >
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="data-[error=true]:text-destructive text-white/90">
                        Email
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/40" />
                          <Input
                            type="email"
                            placeholder="you@adobe.com"
                            autoComplete="email"
                            className="h-11 border-white/15 bg-white/[0.03] pl-10 text-white transition-colors duration-200 placeholder:text-white/30 focus-visible:border-white/30 focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/20"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="data-[error=true]:text-destructive text-white/90">
                          Password
                        </FormLabel>
                        <Link
                          to={ROUTES.forgotPassword}
                          className="text-primary/90 hover:text-primary text-xs font-medium transition-colors hover:underline"
                        >
                          Forgot password?
                        </Link>
                      </div>
                      <FormControl>
                        <div className="relative">
                          <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/40" />
                          <Input
                            type="password"
                            placeholder="••••••••"
                            autoComplete="current-password"
                            className="h-11 border-white/15 bg-white/[0.03] pl-10 text-white transition-colors duration-200 placeholder:text-white/30 focus-visible:border-white/30 focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/20"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  className="h-11 w-full shadow-lg shadow-black/30 transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99]"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    'Sign in'
                  )}
                </Button>
              </form>
            </Form>
          </div>

          <p className="mt-6 text-center text-xs text-white/50">
            Internal access only &middot; contact your admin for an account
          </p>
        </div>
      </div>

      <div className="absolute right-6 bottom-6 z-10 flex items-center gap-2">
        <span className="text-xs text-white/50">Powered by</span>
        <img
          src={hireSenseLogo}
          alt="HireSense.ai"
          className="h-4 w-auto opacity-80"
        />
      </div>
    </div>
  )
}
