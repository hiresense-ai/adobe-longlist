import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Lock, Mail } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
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

  // This page's own bg-zinc-950 always covers the viewport once laid out,
  // but <body>'s background follows the app's light/dark theme (white in
  // light mode) — so any transient gap (initial paint before this element
  // has sized itself, a mobile browser's address bar changing the actual
  // visible height after layout) shows through as white instead of this
  // page's own fixed dark treatment. Pinning body's background here closes
  // that gap for the lifetime of this page, regardless of cause.
  useEffect(() => {
    const previous = document.body.style.backgroundColor
    document.body.style.backgroundColor = 'var(--color-zinc-950)'
    return () => {
      document.body.style.backgroundColor = previous
    }
  }, [])

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
    <div className="relative flex min-h-dvh flex-col bg-zinc-950 lg:flex-row">
      {/* Hero — the reference design's own artwork (Adobe mark, headline,
          tagline, and decorative chart previews are all baked into this
          image), used exactly as provided rather than recreated. Purely
          decorative/hidden below 1024px — the card on the right carries no
          duplicate branding, just the sign-in form itself.
          bg-top (not bg-center): on any viewport wider than the image's own
          ~1:1 ratio, `cover` scales by width and crops the excess off the
          top and bottom — center-anchoring splits that crop evenly and cuts
          the logo off at the very top of the image. Anchoring top keeps the
          logo/headline/tagline (all near the top of the source art) fully
          in frame, at the cost of cropping the decorative wave art at the
          bottom instead on very wide screens. */}
      <div
        aria-hidden="true"
        className="animate-in fade-in relative hidden bg-cover bg-top bg-no-repeat duration-700 motion-reduce:animate-none lg:block lg:w-[58%] lg:shrink-0"
        style={{ backgroundImage: `url(${loginHeroBg})` }}
      >
        {/* Blends the hero into the plain dark area beside it — mostly
            transparent so the artwork reads clearly, only darkening and
            fading to the exact page background color near the right edge,
            so the seam between "image" and "flat color" disappears instead
            of reading as two stacked panels. */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent via-60% to-zinc-950" />
      </div>

      {/* Login card — centered while stacked (hero hidden, this is the only
          content); on lg+, nudged toward the hero edge instead of centered
          across the full remaining width, so it doesn't drift into a wide
          empty gap on large monitors. The left offset scales continuously
          with viewport width (clamped between 4rem and 6rem) rather than
          jumping between fixed breakpoint values, so the balance holds at
          any desktop size, not just common resolutions. */}
      <div className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:justify-start lg:pr-12 lg:pl-[clamp(4rem,6vw,6rem)]">
        <div className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-[440px] duration-500 motion-reduce:animate-none">
          <p className="mb-6 text-center text-sm text-white/60">
            Sign in to access your hiring dashboards
          </p>

          <div className="rounded-[22px] border border-white/10 bg-white/[0.04] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
            <Form {...form}>
              {/* This card is always dark (see the note on this page's fixed
                  brand treatment above), so an autofilled field here must
                  stay dark in BOTH app themes — not follow the theme-level
                  --autofill-* defaults, which go light in light mode and
                  would leave the password toggle invisible on top of it.
                  zinc-900 matches what the input's translucent white layers
                  resolve to over this card. */}
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5 [--autofill-bg:var(--color-zinc-900)] [--autofill-fg:var(--color-white)]"
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
                          <PasswordInput
                            placeholder="••••••••"
                            autoComplete="current-password"
                            className="h-11 border-white/15 bg-white/[0.03] pr-11 pl-10 text-white transition-colors duration-200 placeholder:text-white/30 focus-visible:border-white/30 focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/20"
                            toggleClassName="text-white/60 hover:bg-white/10 hover:text-white"
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
