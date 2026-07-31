import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { KeyRound, Loader2, LogOut } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
import { changeOwnPassword } from '@/supabase/auth'
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS_HINT,
  ROUTES,
  STRONG_PASSWORD_PATTERN,
} from '@/constants'
import { getErrorMessage } from '@/lib/errors'

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      )
      .regex(STRONG_PASSWORD_PATTERN, PASSWORD_REQUIREMENTS_HINT),
    confirmPassword: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'Your new password must be different from your current one',
    path: ['newPassword'],
  })

type FormValues = z.infer<typeof schema>

/**
 * Self-service password change, shared by the Profile page and the forced
 * change gate. Every role uses this same form — the server takes the target
 * account from the caller's JWT, so there is no user id to pass and no way
 * to aim it at somebody else.
 */
export function ChangePasswordForm({
  currentPasswordLabel = 'Current password',
  submitLabel = 'Change password',
  onSignOut,
}: {
  currentPasswordLabel?: string
  submitLabel?: string
  /** Rendered as a secondary escape hatch — used by the forced-change gate,
   * where signing out is otherwise unreachable (no navbar). */
  onSignOut?: () => Promise<void>
}) {
  const { refreshUser } = useAuth()
  const navigate = useNavigate()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  })

  async function onSubmit(values: FormValues) {
    try {
      const { sessionReissued } = await changeOwnPassword(
        values.currentPassword,
        values.newPassword,
      )
      form.reset()

      if (!sessionReissued) {
        // changeOwnPassword already signed out — the password change stuck,
        // there just isn't a live session left to carry on with.
        toast.success('Password updated — please sign in again')
        navigate(ROUTES.login, { replace: true })
        return
      }

      // Re-reads the profile behind the NEW session so force_password_change
      // (cleared server-side) stops gating the app, without a fresh sign-in.
      await refreshUser()
      toast.success('Password updated')
    } catch (error) {
      const message = getErrorMessage(error, "Couldn't change your password")
      // Surface a wrong current password on the field itself rather than
      // only as a toast — that is the one error users actually need to act on.
      if (/current password/i.test(message)) {
        form.setError('currentPassword', { message })
      }
      toast.error(message)
    }
  }

  const isSubmitting = form.formState.isSubmitting

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{currentPasswordLabel}</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  {...field}
                />
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
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          {submitLabel}
        </Button>

        {onSignOut && (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground w-full"
            disabled={isSubmitting}
            onClick={() => void onSignOut()}
          >
            <LogOut className="size-4" />
            Sign out instead
          </Button>
        )}
      </form>
    </Form>
  )
}
