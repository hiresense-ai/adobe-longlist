import { useState, type MouseEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useDeleteDashboard } from '@/hooks/useDeleteDashboard'
import { getErrorMessage } from '@/lib/errors'
import type { Dashboard } from '@/types'

export function DeleteDashboardButton({
  dashboard,
}: {
  dashboard: Pick<Dashboard, 'id' | 'title' | 'storage_path' | 'thumbnail'>
}) {
  const [open, setOpen] = useState(false)
  const deleteMutation = useDeleteDashboard()

  async function handleConfirm(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    try {
      await deleteMutation.mutateAsync(dashboard)
      toast.success(`${dashboard.title} deleted`)
      setOpen(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't delete dashboard"))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Delete ${dashboard.title}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this dashboard?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this dashboard? This removes "
            {dashboard.title}", its HTML file, thumbnail, and every candidate
            status recorded against it. This can't be undone.
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
