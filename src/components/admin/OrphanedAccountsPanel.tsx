import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
import { useOrphanedAuthUsers } from '@/hooks/useOrphanedAuthUsers'
import { useDeleteAdminUser } from '@/hooks/useAdminUserMutations'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/utils/date'
import type { OrphanedAuthUser } from '@/services/adminUsers.service'

/**
 * Surfaces accounts that exist in Supabase Auth with no profiles row behind
 * them — invisible in the main Users table (see admin-users' listUsers) by
 * design, since they have no role and can't sign in. Left alone they
 * permanently block their email from ever being used again. See
 * admin-users' listOrphans for exactly how this happens: never through this
 * app's own create/delete flows, only an out-of-band profiles deletion
 * (e.g. the Supabase Dashboard's table editor).
 *
 * Deliberately renders nothing in the common case (no orphans, or a caller
 * who isn't Super Admin) — this is a rare cleanup surface, not a permanent
 * fixture of the page.
 */
export function OrphanedAccountsPanel({
  isSuperAdmin,
}: {
  isSuperAdmin: boolean
}) {
  const { data: orphans } = useOrphanedAuthUsers(isSuperAdmin)
  const [removing, setRemoving] = useState<OrphanedAuthUser | null>(null)
  const deleteMutation = useDeleteAdminUser()

  if (!isSuperAdmin || !orphans || orphans.length === 0) return null

  async function handleConfirm(event: { preventDefault: () => void }) {
    event.preventDefault()
    if (!removing) return
    try {
      // The existing delete action already handles this exact case: no
      // profile row means it treats the target as an unprivileged account
      // and goes straight to removing the auth user (see deleteUser).
      await deleteMutation.mutateAsync(removing.id)
      toast.success(`Removed the orphaned account for ${removing.email}`)
      setRemoving(null)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't remove this account"))
    }
  }

  return (
    <>
      <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {orphans.length} orphaned account
              {orphans.length === 1 ? '' : 's'} found
            </p>
            <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
              These exist in authentication but have no profile — likely deleted
              directly outside the app. They block their email from being used
              again until removed.
            </p>
            <div className="mt-3 space-y-2">
              {orphans.map((orphan) => (
                <div
                  key={orphan.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-2 dark:border-amber-900 dark:bg-black/20"
                >
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">
                      {orphan.email}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Created {formatDate(orphan.createdAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10 shrink-0"
                    onClick={() => setRemoving(orphan)}
                  >
                    <Trash2 className="size-3.5" />
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this orphaned account?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently deletes the authentication record for "
              {removing?.email}". It has no profile and can't sign in — this
              frees up the email to be used again. This can't be undone.
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
                'Remove'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
