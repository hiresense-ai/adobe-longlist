import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useLocation, useNavigate, type Location } from 'react-router-dom'
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
import { PoweredByHireSense } from '@/components/common/PoweredByHireSense'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES, APP_NAME } from '@/constants'
import { getErrorMessage } from '@/lib/errors'

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
  const location = useLocation()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  const redirectTo =
    (location.state as { from?: Location })?.from?.pathname ?? ROUTES.home

  async function onSubmit(values: LoginFormValues) {
    setIsSubmitting(true)
    try {
      await login(values.email, values.password)
      toast.success('Welcome back!')
      navigate(redirectTo, { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to sign in'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-svh flex-col bg-zinc-950 lg:flex-row">
      {/* Hero — decorative only, hidden below 1024px per spec. No source
          background image was supplied (only shared as a pasted chat
          image, not a file this environment can read), so this is a
          procedural stand-in built from gradients/SVG in the same red/near-
          black palette as the reference design. Swap in a real image via
          a `background-image` on this element if one is provided later. */}
      <div
        aria-hidden="true"
        className="relative isolate hidden overflow-hidden lg:flex lg:w-[58%] lg:shrink-0 lg:flex-col lg:justify-between lg:p-12 xl:p-16"
      >
        <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,rgba(250,15,0,0.32),transparent_60%)]" />
        <svg
          className="absolute inset-0 size-full opacity-[0.35]"
          viewBox="0 0 800 900"
          fill="none"
          preserveAspectRatio="xMidYMid slice"
        >
          <path
            d="M-40 620 C 160 560, 280 720, 480 640 S 820 520, 900 600"
            stroke="url(#loginHeroLine)"
            strokeWidth="1.5"
            fill="none"
          />
          <path
            d="M-40 700 C 180 660, 300 800, 500 720 S 840 600, 900 680"
            stroke="url(#loginHeroLine)"
            strokeWidth="1"
            fill="none"
          />
          <defs>
            <linearGradient id="loginHeroLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#FA0F00" stopOpacity="0" />
              <stop offset="50%" stopColor="#FA0F00" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#FA0F00" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
        {/* Floating chart-preview cards, purely decorative */}
        <div className="absolute top-[38%] right-[8%] hidden h-24 w-40 rounded-xl border border-white/10 bg-white/5 shadow-2xl backdrop-blur-sm xl:block">
          <div className="flex h-full items-end gap-1.5 p-3">
            {[40, 65, 45, 80, 55].map((h, i) => (
              <div
                key={i}
                className="bg-primary/70 w-full rounded-sm"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
        <div className="absolute top-[58%] right-[22%] hidden size-20 rounded-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-sm xl:block">
          <svg viewBox="0 0 36 36" className="size-full p-3">
            <circle
              cx="18"
              cy="18"
              r="14"
              fill="none"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="4"
            />
            <circle
              cx="18"
              cy="18"
              r="14"
              fill="none"
              stroke="#FA0F00"
              strokeWidth="4"
              strokeDasharray="62 88"
              strokeLinecap="round"
              transform="rotate(-90 18 18)"
            />
          </svg>
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/60" />

        <div className="animate-in fade-in relative z-10 flex items-center gap-2.5 duration-700 motion-reduce:animate-none">
          <span className="bg-primary flex size-9 items-center justify-center rounded-lg text-sm font-bold text-white">
            A
          </span>
          <span className="text-base font-semibold text-white">{APP_NAME}</span>
        </div>

        <div className="animate-in fade-in slide-in-from-bottom-2 relative z-10 max-w-md duration-700 motion-reduce:animate-none">
          <h2 className="text-4xl font-bold tracking-tight text-white xl:text-5xl">
            {APP_NAME}
          </h2>
          <div className="bg-primary mt-4 h-1 w-14 rounded-full" />
          <p className="mt-4 text-lg text-white/70">
            Data-driven talent insights.
            <br />
            Smarter hiring decisions.
          </p>
        </div>
      </div>

      {/* Login card */}
      <div className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-[440px] duration-500 motion-reduce:animate-none">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <div className="bg-primary shadow-soft flex size-12 items-center justify-center rounded-2xl text-2xl font-bold text-white">
              A
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">{APP_NAME}</h1>
              <p className="mt-1 text-sm text-white/60">
                Sign in to access your hiring dashboards
              </p>
            </div>
          </div>

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

      <div className="absolute right-6 bottom-6 z-10">
        <PoweredByHireSense className="text-white/50" />
      </div>
    </div>
  )
}
