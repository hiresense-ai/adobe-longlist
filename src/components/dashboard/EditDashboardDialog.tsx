import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { ImageOff, Loader2, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { useUpdateDashboard } from '@/hooks/useUpdateDashboard'
import { useAuth } from '@/hooks/useAuth'
import {
  removeDashboardThumbnailObject,
  uploadDashboardThumbnail,
  validateThumbnailFile,
} from '@/services/dashboardAdmin.service'
import { getErrorMessage } from '@/lib/errors'
import { canManageDashboards } from '@/lib/permissions'
import type { DashboardWithThumbnail } from '@/services/dashboards.service'

const editSchema = z.object({
  title: z.string().min(1, 'Dashboard name is required'),
  description: z.string().optional(),
  category: z.string().optional(),
})

type EditFormValues = z.infer<typeof editSchema>

export function EditDashboardDialog({
  dashboard,
  open,
  onOpenChange,
}: {
  dashboard: DashboardWithThumbnail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useAuth()
  const updateMutation = useUpdateDashboard()
  // Thumbnail controls are Super Admin only — an Admin's edit form never
  // renders them at all, matching the existing upload/replace/delete
  // permission split (see canManageDashboards). The Edge Function enforces
  // this independently regardless of what this component sends.
  const canEditThumbnail = Boolean(user && canManageDashboards(user.role))

  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null)
  const [removeThumbnail, setRemoveThumbnail] = useState(false)
  const [thumbnailError, setThumbnailError] = useState<string | undefined>()

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      title: dashboard.title,
      description: dashboard.description ?? '',
      category: dashboard.category ?? '',
    },
  })

  function resetAll() {
    form.reset({
      title: dashboard.title,
      description: dashboard.description ?? '',
      category: dashboard.category ?? '',
    })
    setThumbnailFile(null)
    setRemoveThumbnail(false)
    setThumbnailError(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next && !updateMutation.isPending) resetAll()
    onOpenChange(next)
  }

  function handleThumbnailChange(file: File | null) {
    setThumbnailFile(file)
    setThumbnailError(undefined)
    if (file) setRemoveThumbnail(false)
  }

  async function onSubmit(values: EditFormValues) {
    if (thumbnailFile) {
      const error = validateThumbnailFile(thumbnailFile)
      if (error) {
        setThumbnailError(error)
        return
      }
    }

    let newThumbnailPath: string | null = null

    try {
      if (canEditThumbnail && thumbnailFile) {
        newThumbnailPath = await uploadDashboardThumbnail(
          dashboard.id,
          thumbnailFile,
        )
      }

      const thumbnailChanged =
        canEditThumbnail && (Boolean(newThumbnailPath) || removeThumbnail)

      await updateMutation.mutateAsync({
        dashboardId: dashboard.id,
        title: values.title,
        description: values.description,
        category: values.category,
        ...(thumbnailChanged ? { thumbnail: newThumbnailPath } : {}),
      })

      // Best-effort cleanup of the previous thumbnail object, only once the
      // dashboard row no longer points at it.
      if (thumbnailChanged && dashboard.thumbnail) {
        await removeDashboardThumbnailObject(dashboard.thumbnail)
      }

      toast.success(`${values.title} updated successfully`)
      resetAll()
      onOpenChange(false)
    } catch (error) {
      // The new thumbnail object was already uploaded but the dashboard row
      // update failed — clean it up so it doesn't linger as an orphan.
      if (newThumbnailPath) {
        await removeDashboardThumbnailObject(newThumbnailPath)
      }
      toast.error(getErrorMessage(error, "Couldn't update dashboard"))
    }
  }

  const isSubmitting = updateMutation.isPending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit dashboard</DialogTitle>
          <DialogDescription>
            {canEditThumbnail
              ? "Update this dashboard's details and thumbnail."
              : "Update this dashboard's name, description, and category."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dashboard name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Design Dashboard"
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
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What is this dashboard for?"
                      rows={3}
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
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Design"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {canEditThumbnail && (
              <div className="grid gap-2">
                <Label htmlFor="dashboard-edit-thumbnail-file">
                  Thumbnail image
                </Label>
                {dashboard.thumbnailUrl &&
                  !removeThumbnail &&
                  !thumbnailFile && (
                    <div className="flex items-center gap-3">
                      <img
                        src={dashboard.thumbnailUrl}
                        alt=""
                        className="border-border size-14 shrink-0 rounded-md border object-cover"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isSubmitting}
                        onClick={() => setRemoveThumbnail(true)}
                      >
                        <ImageOff className="size-3.5" />
                        Remove thumbnail
                      </Button>
                    </div>
                  )}
                {removeThumbnail && (
                  <p className="text-muted-foreground text-xs">
                    Thumbnail will be removed when you save.{' '}
                    <button
                      type="button"
                      className="text-foreground underline underline-offset-2"
                      onClick={() => setRemoveThumbnail(false)}
                    >
                      Undo
                    </button>
                  </p>
                )}
                <Input
                  id="dashboard-edit-thumbnail-file"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={isSubmitting}
                  onChange={(event) =>
                    handleThumbnailChange(event.target.files?.[0] ?? null)
                  }
                />
                <p className="text-muted-foreground text-xs">
                  JPG, PNG, or WEBP — up to 5 MB.
                </p>
                {thumbnailError && (
                  <p className="text-destructive text-sm">{thumbnailError}</p>
                )}
              </div>
            )}

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
                  <Save className="size-4" />
                )}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
