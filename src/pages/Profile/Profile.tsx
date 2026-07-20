import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { LogOut, Mail, ShieldCheck, User as UserIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import { getInitials } from '@/lib/format'

export function Profile() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleLogout() {
    setIsSigningOut(true)
    try {
      await logout()
      navigate(ROUTES.login, { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to sign out'))
      setIsSigningOut(false)
    }
  }

  if (!user) return null

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-foreground mb-6 text-2xl font-semibold">
        Your profile
      </h1>

      <div className="border-border bg-card shadow-soft rounded-2xl border p-6 sm:p-8">
        <div className="flex items-center gap-4">
          <Avatar className="size-16">
            <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">
              {getInitials(user.name ?? user.email)}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-foreground text-lg font-medium">
              {user.name ?? 'Unnamed user'}
            </p>
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/5 text-primary mt-1 capitalize"
            >
              {user.role}
            </Badge>
          </div>
        </div>

        <Separator className="my-6" />

        <dl className="space-y-4 text-sm">
          <div className="flex items-center gap-3">
            <Mail className="text-muted-foreground size-4" />
            <dt className="text-muted-foreground">Email</dt>
            <dd className="text-foreground ml-auto font-medium">
              {user.email}
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <UserIcon className="text-muted-foreground size-4" />
            <dt className="text-muted-foreground">User ID</dt>
            <dd className="text-foreground ml-auto font-mono text-xs">
              {user.id}
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <ShieldCheck className="text-muted-foreground size-4" />
            <dt className="text-muted-foreground">Role</dt>
            <dd className="text-foreground ml-auto font-medium capitalize">
              {user.role}
            </dd>
          </div>
        </dl>

        <Separator className="my-6" />

        <Button
          variant="outline"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive w-full"
          onClick={handleLogout}
          disabled={isSigningOut}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>
    </div>
  )
}
