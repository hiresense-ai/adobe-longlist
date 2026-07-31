import { toast } from 'sonner'
import {
  KeyRound,
  Loader2,
  LockKeyholeOpen,
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
import {
  useSetAdminUserDisabled,
  useUnlockAdminUser,
} from '@/hooks/useAdminUserMutations'
import { getErrorMessage } from '@/lib/errors'
import {
  canDisableOrDelete,
  canResetPassword,
  canUnlock,
} from '@/lib/permissions'
import type { AdminUserRow, UserRole } from '@/types'

export function UserRowActions({
  user,
  currentUserId,
  currentUserRole,
  onEdit,
  onDelete,
  onResetPassword,
}: {
  user: AdminUserRow
  currentUserId: string | undefined
  currentUserRole: UserRole
  onEdit: (user: AdminUserRow) => void
  onDelete: (user: AdminUserRow) => void
  onResetPassword: (user: AdminUserRow) => void
}) {
  const setDisabledMutation = useSetAdminUserDisabled()
  const unlockMutation = useUnlockAdminUser()
  const isSelf = user.id === currentUserId

  // super_admin is never editable/disable-able/deletable through this menu
  // at all (see admin-users/index.ts) — canDisableOrDelete already reflects
  // that, and the same hierarchy applies to Edit, so it's reused here too.
  const canManage = canDisableOrDelete(currentUserRole, user.role)
  const canUnlockThis = user.locked && canUnlock(currentUserRole, user.role)
  // Unlike canManage, this DOES allow a super_admin target — password reset
  // is the one action permitted against a Super Admin (see permissions.ts).
  const canSetPassword = canResetPassword(currentUserRole, user.role)

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

  async function handleUnlock() {
    try {
      await unlockMutation.mutateAsync(user.id)
      toast.success(`${user.email} unlocked`)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't unlock account"))
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
      <DropdownMenuContent align="end" className="w-52">
        {/* Unlock only ever appears when it would actually do something —
            the account is locked AND the current user has permission — per
            the "show the button only if permitted" requirement. */}
        {canUnlockThis && (
          <>
            <DropdownMenuItem
              onClick={handleUnlock}
              disabled={unlockMutation.isPending}
            >
              {unlockMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LockKeyholeOpen className="size-4" />
              )}
              Unlock account
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem onClick={() => onEdit(user)} disabled={!canManage}>
          <Pencil className="size-4" />
          Edit
        </DropdownMenuItem>
        {/* "Send reset email" used to sit here. Removed with the rest of the
            email flow — this portal issues a temporary password in-app
            instead, which the admin passes on directly. */}
        {canSetPassword && (
          <DropdownMenuItem onClick={() => onResetPassword(user)}>
            <KeyRound className="size-4" />
            Reset password
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={handleToggleDisabled}
          disabled={setDisabledMutation.isPending || isSelf || !canManage}
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
          disabled={isSelf || !canManage}
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
