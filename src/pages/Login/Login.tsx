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
            <p className="text-muted-foreground text-sm">
              Sign in to view your dashboards
            </p>
          </div>
        </div>

        <div className="border-border bg-card shadow-soft rounded-2xl border p-6 sm:p-8">
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
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                          type="email"
                          placeholder="you@adobe.com"
                          autoComplete="email"
                          className="pl-9"
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
                      <FormLabel>Password</FormLabel>
                      <Link
                        to={ROUTES.forgotPassword}
                        className="text-primary text-xs font-medium hover:underline"
                      >
                        Forgot password?
                      </Link>
                    </div>
                    <FormControl>
                      <div className="relative">
                        <Lock className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                          type="password"
                          placeholder="••••••••"
                          autoComplete="current-password"
                          className="pl-9"
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
                className="h-10 w-full"
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

        <p className="text-muted-foreground mt-6 text-center text-xs">
          Internal access only &middot; contact your admin for an account
        </p>
      </div>
    </div>
  )
}
