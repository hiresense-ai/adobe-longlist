import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Mail } from 'lucide-react'

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
import { sendPasswordResetEmail } from '@/supabase/auth'
import { ROUTES, APP_NAME } from '@/constants'
import { getErrorMessage } from '@/lib/errors'

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
})

type FormValues = z.infer<typeof schema>

export function ForgotPassword() {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSent, setIsSent] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  })

  async function onSubmit(values: FormValues) {
    setIsSubmitting(true)
    try {
      await sendPasswordResetEmail(values.email)
      setIsSent(true)
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to send reset email'))
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
            <p className="text-muted-foreground text-sm">Reset your password</p>
          </div>
        </div>

        <div className="border-border bg-card shadow-soft rounded-2xl border p-6 sm:p-8">
          {isSent ? (
            <div className="space-y-4 text-center">
              <p className="text-foreground text-sm">
                If an account exists for that email, a reset link is on its way.
                Check your inbox.
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link to={ROUTES.login}>Back to sign in</Link>
              </Button>
            </div>
          ) : (
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

                <Button
                  type="submit"
                  className="h-10 w-full"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    'Send reset link'
                  )}
                </Button>

                <Link
                  to={ROUTES.login}
                  className="text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 text-sm"
                >
                  <ArrowLeft className="size-3.5" />
                  Back to sign in
                </Link>
              </form>
            </Form>
          )}
        </div>
      </div>
    </div>
  )
}
