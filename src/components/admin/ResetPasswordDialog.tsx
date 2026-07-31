import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { useResetAdminUserPassword } from '@/hooks/useAdminUserMutations'
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS_HINT,
  STRONG_PASSWORD_PATTERN,
} from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import type { AdminUserRow } from '@/types'

const resetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
    .regex(STRONG_PASSWORD_PATTERN, PASSWORD_REQUIREMENTS_HINT),
})

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>

/**
 * Super Admin's "set a new password directly" capability — distinct from
 * the "Send reset email" action every admin has (UserRowActions), which
 * only ever emails the account holder a link and never lets an admin see
 * or choose the password themselves.
 */
export function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: AdminUserRow | null
  onOpenChange: (open: boolean) => void
}) {
  const resetMutation = useResetAdminUserPassword()

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '' },
  })

  function handleOpenChange(next: boolean) {
    if (!next && !resetMutation.isPending) form.reset()
    onOpenChange(next)
  }

  async function onSubmit(values: ResetPasswordFormValues) {
    if (!user) return
    try {
      await resetMutation.mutateAsync({
        userId: user.id,
        newPassword: values.newPassword,
      })
      toast.success(`Password reset for ${user.name ?? user.email}`)
      form.reset()
      onOpenChange(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't reset password"))
    }
  }

  const isSubmitting = resetMutation.isPending

  return (
    <Dialog open={Boolean(user)} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set a new password</DialogTitle>
          <DialogDescription>
            Directly sets {user?.name ?? user?.email}'s password. They are not
            notified — share the new password with them yourself if needed.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Set password
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
