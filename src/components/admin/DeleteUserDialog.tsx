import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useDeleteAdminUser } from '@/hooks/useAdminUserMutations'
import { getErrorMessage } from '@/lib/errors'
import type { AdminUserRow } from '@/types'

export function DeleteUserDialog({
  user,
  onOpenChange,
}: {
  user: AdminUserRow | null
  onOpenChange: (open: boolean) => void
}) {
  const deleteMutation = useDeleteAdminUser()

  async function handleConfirm(event: { preventDefault: () => void }) {
    event.preventDefault()
    if (!user) return
    try {
      await deleteMutation.mutateAsync(user.id)
      toast.success(`${user.name ?? user.email} was deleted`)
      onOpenChange(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't delete user"))
    }
  }

  return (
    <AlertDialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this user?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes "{user?.name ?? user?.email}"'s account and
            profile. Dashboards and status history they created are kept, just
            no longer attributed to them. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={handleConfirm}
          >
            {deleteMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
