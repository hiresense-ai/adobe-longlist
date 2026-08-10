import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2, Plus, Upload, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
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
import { useUploadDashboard } from '@/hooks/useUploadDashboard'
import { useAssignableUsers } from '@/hooks/useAdminUsers'
import { useAuth } from '@/hooks/useAuth'
import {
  validateHtmlFile,
  validateThumbnailFile,
} from '@/services/dashboardAdmin.service'
import { assignDashboardUser } from '@/services/dashboardAssignments.service'
import { getErrorMessage } from '@/lib/errors'
import { assignableDashboardRoles, roleLabel } from '@/lib/permissions'
import type { AdminUserRow } from '@/types'

const uploadSchema = z.object({
  title: z.string().min(1, 'Dashboard name is required'),
  description: z.string().optional(),
  category: z.string().optional(),
})

type UploadFormValues = z.infer<typeof uploadSchema>

const STAGE_LABEL: Record<string, string> = {
  normalizing: 'Validating dashboard format…',
  html: 'Uploading HTML file…',
  thumbnail: 'Uploading thumbnail…',
  saving: 'Saving dashboard…',
}

export function UploadDashboardDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useAuth()
  const uploadMutation = useUploadDashboard()
  const { data: allUsers } = useAssignableUsers(open)
  const [htmlFile, setHtmlFile] = useState<File | null>(null)
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null)
  const [fileErrors, setFileErrors] = useState<{
    html?: string
    thumbnail?: string
  }>({})
  const [progress, setProgress] = useState<{
    stage: string
    percent: number
  } | null>(null)

  // A new dashboard starts with zero rows in dashboard_assignments, so
  // (post assignment migration) nobody but a Super Admin can see it until
  // someone is granted access — either here, or afterward via the
  // "Manage Access" button on the card. Staged locally since the dashboard
  // doesn't have an id yet; actually granted only once the upload succeeds.
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('')
  const [pendingAssignees, setPendingAssignees] = useState<AdminUserRow[]>([])

  const eligibleRoles = assignableDashboardRoles(user?.role ?? 'viewer')
  const pendingIds = useMemo(
    () => new Set(pendingAssignees.map((assignee) => assignee.id)),
    [pendingAssignees],
  )
  const eligibleToAssign = useMemo(
    () =>
      (allUsers ?? []).filter(
        (candidate) =>
          eligibleRoles.includes(candidate.role) &&
          !pendingIds.has(candidate.id),
      ),
    [allUsers, eligibleRoles, pendingIds],
  )

  function handleAddAssignee() {
    if (!selectedAssigneeId) return
    const candidate = (allUsers ?? []).find((u) => u.id === selectedAssigneeId)
    if (!candidate) return
    setPendingAssignees((prev) => [...prev, candidate])
    setSelectedAssigneeId('')
  }

  function handleRemoveAssignee(userId: string) {
    setPendingAssignees((prev) => prev.filter((a) => a.id !== userId))
  }

  const form = useForm<UploadFormValues>({
    resolver: zodResolver(uploadSchema),
    defaultValues: { title: '', description: '', category: '' },
  })

  function resetAll() {
    form.reset()
    setHtmlFile(null)
    setThumbnailFile(null)
    setFileErrors({})
    setProgress(null)
    setPendingAssignees([])
    setSelectedAssigneeId('')
  }

  function handleOpenChange(next: boolean) {
    if (!next && !uploadMutation.isPending) resetAll()
    onOpenChange(next)
  }

  async function onSubmit(values: UploadFormValues) {
    if (!user) return

    const nextErrors: { html?: string; thumbnail?: string } = {}
    if (!htmlFile) {
      nextErrors.html = 'An HTML file is required.'
    } else {
      const error = validateHtmlFile(htmlFile)
      if (error) nextErrors.html = error
    }
    if (thumbnailFile) {
      const error = validateThumbnailFile(thumbnailFile)
      if (error) nextErrors.thumbnail = error
    }
    setFileErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || !htmlFile) return

    try {
      setProgress({ stage: 'html', percent: 5 })
      const created = await uploadMutation.mutateAsync({
        title: values.title,
        description: values.description,
        category: values.category,
        htmlFile,
        thumbnailFile,
        createdBy: user.id,
        onProgress: (stage, percent) => setProgress({ stage, percent }),
      })

      if (pendingAssignees.length > 0) {
        const results = await Promise.allSettled(
          pendingAssignees.map((assignee) =>
            assignDashboardUser(created.id, assignee.id),
          ),
        )
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) {
          toast.warning(
            `${values.title} uploaded, but couldn't grant access to ${failed} user(s). Use "Manage Access" on the card to retry.`,
          )
        }
      }

      toast.success(`${values.title} uploaded successfully`)
      resetAll()
      onOpenChange(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't upload dashboard"))
      setProgress(null)
    }
  }

  const isSubmitting = uploadMutation.isPending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload dashboard</DialogTitle>
          <DialogDescription>
            Add a new HTML dashboard and an optional thumbnail image.
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

            <div className="grid gap-2">
              <Label htmlFor="dashboard-html-file">HTML file</Label>
              <Input
                id="dashboard-html-file"
                type="file"
                accept=".html,text/html"
                disabled={isSubmitting}
                onChange={(event) => {
                  setHtmlFile(event.target.files?.[0] ?? null)
                  setFileErrors((prev) => ({ ...prev, html: undefined }))
                }}
              />
              <p className="text-muted-foreground text-xs">
                HTML file — up to 10 MB.
              </p>
              {fileErrors.html && (
                <p className="text-destructive text-sm">{fileErrors.html}</p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="dashboard-thumbnail-file">
                Thumbnail image (optional)
              </Label>
              <Input
                id="dashboard-thumbnail-file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={isSubmitting}
                onChange={(event) => {
                  setThumbnailFile(event.target.files?.[0] ?? null)
                  setFileErrors((prev) => ({ ...prev, thumbnail: undefined }))
                }}
              />
              <p className="text-muted-foreground text-xs">
                JPG, PNG, or WEBP — up to 5 MB.
              </p>
              {fileErrors.thumbnail && (
                <p className="text-destructive text-sm">
                  {fileErrors.thumbnail}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label>Grant access (optional)</Label>
              <p className="text-muted-foreground text-xs">
                Only you can see this dashboard until someone is granted access.
                You can also do this later from the card.
              </p>
              {pendingAssignees.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingAssignees.map((assignee) => (
                    <Badge
                      key={assignee.id}
                      variant="secondary"
                      className="gap-1 pr-1"
                    >
                      {assignee.name || assignee.email}
                      <button
                        type="button"
                        aria-label={`Remove ${assignee.email}`}
                        disabled={isSubmitting}
                        onClick={() => handleRemoveAssignee(assignee.id)}
                        className="hover:bg-background/60 rounded-full p-0.5"
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Select
                  value={selectedAssigneeId}
                  onValueChange={setSelectedAssigneeId}
                  disabled={isSubmitting}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Add a user…" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleToAssign.length === 0 ? (
                      <div className="text-muted-foreground px-2 py-1.5 text-sm">
                        No eligible users left to add.
                      </div>
                    ) : (
                      eligibleToAssign.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {`${candidate.name || candidate.email} — ${roleLabel(candidate.role)}`}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddAssignee}
                  disabled={!selectedAssigneeId || isSubmitting}
                >
                  <Plus className="size-4" />
                  Add
                </Button>
              </div>
            </div>

            {progress && (
              <div className="space-y-1.5">
                <Progress value={progress.percent} />
                <p className="text-muted-foreground text-xs">
                  {STAGE_LABEL[progress.stage] ?? 'Uploading…'}
                </p>
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
                  <Upload className="size-4" />
                )}
                Upload
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
