import { useState } from 'react'
import { toast } from 'sonner'
import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  ShieldOff,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSetAdminUserDisabled } from '@/hooks/useAdminUserMutations'
import { sendPasswordResetEmail } from '@/supabase/auth'
import { getErrorMessage } from '@/lib/errors'
import type { AdminUserRow } from '@/types'

export function UserRowActions({
  user,
  currentUserId,
  onEdit,
  onDelete,
}: {
  user: AdminUserRow
  currentUserId: string | undefined
  onEdit: (user: AdminUserRow) => void
  onDelete: (user: AdminUserRow) => void
}) {
  const setDisabledMutation = useSetAdminUserDisabled()
  const [isResetting, setIsResetting] = useState(false)
  const isSelf = user.id === currentUserId

  async function handleResetPassword() {
    setIsResetting(true)
    try {
      await sendPasswordResetEmail(user.email)
      toast.success(`Password reset email sent to ${user.email}`)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't send reset email"))
    } finally {
      setIsResetting(false)
    }
  }

  async function handleToggleDisabled() {
    try {
      await setDisabledMutation.mutateAsync({
        userId: user.id,
        disabled: !user.disabled,
      })
      toast.success(
        user.disabled ? `${user.email} re-enabled` : `${user.email} disabled`,
      )
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't update user status"))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Actions for ${user.email}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => onEdit(user)}>
          <Pencil className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleResetPassword} disabled={isResetting}>
          {isResetting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          Reset password
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleToggleDisabled}
          disabled={setDisabledMutation.isPending || isSelf}
        >
          {user.disabled ? (
            <ShieldCheck className="size-4" />
          ) : (
            <ShieldOff className="size-4" />
          )}
          {user.disabled ? 'Enable' : 'Disable'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDelete(user)}
          disabled={isSelf}
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
