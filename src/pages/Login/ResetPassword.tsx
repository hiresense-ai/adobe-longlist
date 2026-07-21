import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Lock } from 'lucide-react'

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
import { updatePassword } from '@/supabase/auth'
import {
  ROUTES,
  APP_NAME,
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS_HINT,
  STRONG_PASSWORD_PATTERN,
} from '@/constants'
import { getErrorMessage } from '@/lib/errors'

const schema = z
  .object({
    password: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      )
      .regex(STRONG_PASSWORD_PATTERN, PASSWORD_REQUIREMENTS_HINT),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type FormValues = z.infer<typeof schema>

export function ResetPassword() {
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  async function onSubmit(values: FormValues) {
    setIsSubmitting(true)
    try {
      await updatePassword(values.password)
      toast.success('Password updated. Please sign in again.')
      navigate(ROUTES.login, { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to update password'))
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
              Choose a new password
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
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                          type="password"
                          placeholder="••••••••"
                          autoComplete="new-password"
                          className="pl-9"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <p className="text-muted-foreground text-xs">
                      At least {MIN_PASSWORD_LENGTH} characters.{' '}
                      {PASSWORD_REQUIREMENTS_HINT}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                          type="password"
                          placeholder="••••••••"
                          autoComplete="new-password"
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
                  'Update password'
                )}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  )
}
