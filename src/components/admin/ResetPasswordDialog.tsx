import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Check, Copy, KeyRound, Loader2, Sparkles } from 'lucide-react'

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
import { generateSecurePassword } from '@/lib/generatePassword'
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
 * Administrator-set temporary password.
 *
 * There is no email in this portal, so the password is displayed once, here,
 * for the admin to pass to the user out of band. The server flags the
 * account with force_password_change, so the user must replace it before
 * they can use the app again.
 */
export function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: AdminUserRow | null
  onOpenChange: (open: boolean) => void
}) {
  const resetMutation = useResetAdminUserPassword()
  // Set only after a successful reset — this is the hand-off screen.
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '' },
  })

  function handleOpenChange(next: boolean) {
    if (!next && !resetMutation.isPending) {
      form.reset()
      setIssuedPassword(null)
      setCopied(false)
    }
    onOpenChange(next)
  }

  function handleGenerate() {
    form.setValue('newPassword', generateSecurePassword(), {
      shouldValidate: true,
      shouldDirty: true,
    })
  }

  async function handleCopy() {
    if (!issuedPassword) return
    try {
      await navigator.clipboard.writeText(issuedPassword)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed — select the password and copy it manually.')
    }
  }

  async function onSubmit(values: ResetPasswordFormValues) {
    if (!user) return
    try {
      await resetMutation.mutateAsync({
        userId: user.id,
        newPassword: values.newPassword,
      })
      setIssuedPassword(values.newPassword)
      form.reset()
      toast.success(`Password reset for ${user.name ?? user.email}`)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't reset password"))
    }
  }

  const isSubmitting = resetMutation.isPending

  return (
    <Dialog open={Boolean(user)} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {issuedPassword ? 'Temporary password' : 'Set a temporary password'}
          </DialogTitle>
          <DialogDescription>
            {issuedPassword
              ? `Share this with ${user?.name ?? user?.email} directly. It won't be shown again, and they'll be required to choose their own password before they can use the app.`
              : `Sets a temporary password for ${user?.name ?? user?.email}. Nobody is emailed — pass it to them yourself. They'll be required to change it at next sign-in.`}
          </DialogDescription>
        </DialogHeader>

        {issuedPassword ? (
          <div className="space-y-4">
            <div className="border-border bg-muted/50 flex items-center gap-2 rounded-lg border p-3">
              <code className="text-foreground flex-1 font-mono text-sm break-all">
                {issuedPassword}
              </code>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Copy password"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between gap-2">
                      <FormLabel>Temporary password</FormLabel>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-auto px-2 py-1 text-xs"
                        onClick={handleGenerate}
                        disabled={isSubmitting}
                      >
                        <Sparkles className="size-3.5" />
                        Generate secure password
                      </Button>
                    </div>
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
                  Reset password
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
