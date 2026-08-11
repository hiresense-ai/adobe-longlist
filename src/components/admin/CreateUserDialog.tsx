import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Sparkles,
  UserPlus,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateAdminUser } from '@/hooks/useAdminUserMutations'
import { useAuth } from '@/hooks/useAuth'
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS_HINT,
  STRONG_PASSWORD_PATTERN,
} from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import { generateSecurePassword } from '@/lib/generatePassword'
import { assignableRoles, roleLabel } from '@/lib/permissions'

const createUserSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z
    .string()
    .min(1, 'Generate a password to continue')
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
    .regex(STRONG_PASSWORD_PATTERN, PASSWORD_REQUIREMENTS_HINT),
  role: z.enum(['admin', 'viewer']),
})

type CreateUserFormValues = z.infer<typeof createUserSchema>

/**
 * Password is ALWAYS generated, never typed — there is no manual-password
 * option. Every account this dialog creates gets force_password_change =
 * true server-side (see admin-users' createUser), unconditionally: the
 * owner must set their own password at first login before reaching any
 * protected route, with no way to defer it. See ForcePasswordChangeGate.
 */
export function CreateUserDialog({
  open,
  onOpenChange,
  existingEmails,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingEmails: string[]
}) {
  const { user: currentUser } = useAuth()
  const roles = assignableRoles(currentUser?.role ?? 'viewer')
  const createMutation = useCreateAdminUser()

  // Set only after a successful create — this is the one-time hand-off
  // screen, same pattern as ResetPasswordDialog. The generated password is
  // only ever known to this browser tab; if it isn't copied now, it's gone
  // (never emailed, never stored in the clear).
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null)
  const [createdName, setCreatedName] = useState('')
  const [copied, setCopied] = useState(false)
  // Drives the submit button's disabled state. Deliberately a plain
  // useState set from handleGenerate, not form.watch('password') — watch()
  // returns a function the React Compiler can't safely memoize, which is
  // avoidable here since only "has a password been generated at all" (not
  // its live value) is needed outside the field's own render.
  const [hasPassword, setHasPassword] = useState(false)

  const form = useForm<CreateUserFormValues>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      password: '',
      role: 'viewer',
    },
  })

  function handleOpenChange(next: boolean) {
    if (!next && !createMutation.isPending) {
      form.reset()
      setIssuedPassword(null)
      setCreatedName('')
      setCopied(false)
      setHasPassword(false)
    }
    onOpenChange(next)
  }

  function handleGenerate() {
    form.setValue('password', generateSecurePassword(), {
      shouldValidate: true,
      shouldDirty: true,
    })
    setHasPassword(true)
  }

  async function handleCopy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed — select the password and copy it manually.')
    }
  }

  async function onSubmit(values: CreateUserFormValues) {
    if (existingEmails.includes(values.email.toLowerCase())) {
      form.setError('email', {
        message: 'A user with this email already exists.',
      })
      return
    }

    try {
      await createMutation.mutateAsync(values)
      // Hand-off screen instead of an immediate close — see the module
      // comment on issuedPassword above.
      setIssuedPassword(values.password)
      setCreatedName(`${values.firstName} ${values.lastName}`.trim())
      form.reset()
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't create user"))
    }
  }

  const isSubmitting = createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {issuedPassword ? 'User created' : 'Create user'}
          </DialogTitle>
          <DialogDescription>
            {issuedPassword
              ? `Share this password with ${createdName || 'the new user'} directly. It won't be shown again. They'll be required to set their own password the first time they sign in.`
              : roles.length > 1
                ? 'Add a new admin or viewer account.'
                : 'Add a new viewer account.'}
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
                onClick={() => void handleCopy(issuedPassword)}
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
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Jane"
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
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Doe"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="jane.doe@adobe.com"
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
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Initial password</FormLabel>
                    {field.value ? (
                      <>
                        <div className="flex items-center gap-2">
                          <FormControl>
                            <PasswordInput
                              readOnly
                              autoComplete="off"
                              disabled={isSubmitting}
                              {...field}
                            />
                          </FormControl>
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            aria-label="Copy password"
                            disabled={isSubmitting}
                            onClick={() => void handleCopy(field.value)}
                          >
                            {copied ? (
                              <Check className="size-4 text-emerald-600" />
                            ) : (
                              <Copy className="size-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="shrink-0"
                            disabled={isSubmitting}
                            onClick={handleGenerate}
                          >
                            <RefreshCw className="size-3.5" />
                            Regenerate
                          </Button>
                        </div>
                        <p className="text-muted-foreground text-xs">
                          At least {MIN_PASSWORD_LENGTH} characters.{' '}
                          {PASSWORD_REQUIREMENTS_HINT}
                        </p>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={isSubmitting}
                        onClick={handleGenerate}
                      >
                        <Sparkles className="size-4" />
                        Generate secure password
                      </Button>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {roles.map((role) => (
                          <SelectItem key={role} value={role}>
                            {roleLabel(role)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                <Button type="submit" disabled={isSubmitting || !hasPassword}>
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserPlus className="size-4" />
                  )}
                  Create user
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
