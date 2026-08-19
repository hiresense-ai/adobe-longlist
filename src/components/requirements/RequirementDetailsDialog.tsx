import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  PhoneCall,
  Save,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
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
import { RequirementStatusBadge } from '@/components/requirements/RequirementStatusBadge'
import { TagInput } from '@/components/requirements/TagInput'
import {
  useDeleteRequirement,
  useUpdateRequirement,
  useUpdateRequirementStatus,
} from '@/hooks/useRequirements'
import { useAuth } from '@/hooks/useAuth'
import { getErrorMessage } from '@/lib/errors'
import {
  canDeleteRequirements,
  canEditRequirement,
  canManageRequirementLifecycle,
} from '@/lib/permissions'
import { formatDate } from '@/utils/date'
import {
  REQUIREMENT_STATUSES,
  type Requirement,
  type RequirementStatus,
  type RequirementUserRef,
} from '@/services/requirements.service'

const editSchema = z
  .object({
    title: z.string().min(1, 'Requirement title is required'),
    jdUrl: z
      .string()
      .trim()
      .refine((value) => !value || /^https?:\/\//i.test(value), {
        message: 'JD link must start with http:// or https://',
      }),
    jdText: z.string(),
    contactNotes: z.string(),
  })
  .refine((value) => value.jdText.trim() || value.jdUrl.trim(), {
    message: 'A requirement must keep a job description or a JD link.',
    path: ['jdText'],
  })

type EditFormValues = z.infer<typeof editSchema>

/** Read-only chip row — rendered only when the list has entries, so an
 * empty Optional Skills/Target Companies list adds no blank section. */
function ChipList({ label, values }: { label: string; values?: string[] }) {
  if (!values || values.length === 0) return null
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  )
}

function UserLine({ user }: { user: RequirementUserRef | null }) {
  if (!user) return <span className="text-muted-foreground">Unknown</span>
  return (
    <span>
      <span className="text-foreground">{user.name || user.email}</span>
      {user.name && (
        <span className="text-muted-foreground block truncate text-xs">
          {user.email}
        </span>
      )}
    </span>
  )
}

/**
 * View/edit/lifecycle dialog for one requirement. Everything rendered here
 * comes from the role/status-shaped response of the requirements Edge
 * Function — a Viewer's post-Contacted requirement arrives WITHOUT the JD
 * and contact fields (hasFullDetails: false), so there is nothing
 * restricted in this component's props to leak. Buttons are shown per the
 * permission helpers, and every action is re-authorized server-side.
 */
export function RequirementDetailsDialog({
  requirement,
  open,
  onOpenChange,
}: {
  requirement: Requirement
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useAuth()
  const role = user?.role ?? 'viewer'
  const updateMutation = useUpdateRequirement()
  const statusMutation = useUpdateRequirementStatus()
  const deleteMutation = useDeleteRequirement()

  const [mode, setMode] = useState<'view' | 'edit' | 'contact'>('view')
  const [contactNotes, setContactNotes] = useState('')
  // Chip lists live outside react-hook-form (they're arrays, not text
  // fields) — seeded from the requirement when Edit starts.
  const [editTopSkills, setEditTopSkills] = useState<string[]>([])
  const [editOptionalSkills, setEditOptionalSkills] = useState<string[]>([])
  const [editTargetCompanies, setEditTargetCompanies] = useState<string[]>([])
  const [topSkillsError, setTopSkillsError] = useState<string | undefined>()

  const isOwner = Boolean(user && requirement.createdBy?.id === user.id)
  const isPending = requirement.status === 'Pending'
  const canEdit = canEditRequirement(role, { isOwner, isPending })
  const canManageLifecycle = canManageRequirementLifecycle(role)
  const canDelete = canDeleteRequirements(role)
  const isBusy =
    updateMutation.isPending ||
    statusMutation.isPending ||
    deleteMutation.isPending

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      title: requirement.title,
      jdUrl: requirement.jdUrl ?? '',
      jdText: requirement.jdText ?? '',
      contactNotes: requirement.contactNotes ?? '',
    },
  })

  function startEdit() {
    form.reset({
      title: requirement.title,
      jdUrl: requirement.jdUrl ?? '',
      jdText: requirement.jdText ?? '',
      contactNotes: requirement.contactNotes ?? '',
    })
    setEditTopSkills(requirement.topSkills ?? [])
    setEditOptionalSkills(requirement.optionalSkills ?? [])
    setEditTargetCompanies(requirement.targetCompanies ?? [])
    setTopSkillsError(undefined)
    setMode('edit')
  }

  function handleOpenChange(next: boolean) {
    if (!next && !isBusy) {
      setMode('view')
      setContactNotes('')
    }
    onOpenChange(next)
  }

  async function onSaveEdit(values: EditFormValues) {
    if (editTopSkills.length === 0) {
      setTopSkillsError('Add at least one top skill.')
      return
    }
    try {
      await updateMutation.mutateAsync({
        requirementId: requirement.id,
        title: values.title,
        jdText: values.jdText.trim() || null,
        jdUrl: values.jdUrl.trim() || null,
        topSkills: editTopSkills,
        optionalSkills: editOptionalSkills,
        targetCompanies: editTargetCompanies,
        // The contactNotes key is only ever sent by a Super Admin — the
        // Edge Function rejects the key outright from anyone else.
        ...(canManageLifecycle
          ? { contactNotes: values.contactNotes.trim() || null }
          : {}),
      })
      toast.success('Requirement updated')
      setMode('view')
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't update requirement"))
    }
  }

  async function changeStatus(
    status: RequirementStatus,
    notes?: string | null,
  ) {
    try {
      await statusMutation.mutateAsync({
        requirementId: requirement.id,
        status,
        ...(notes !== undefined ? { contactNotes: notes } : {}),
      })
      toast.success(`Marked as ${status}`)
      setMode('view')
      setContactNotes('')
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't update status"))
    }
  }

  async function onDelete() {
    try {
      await deleteMutation.mutateAsync(requirement.id)
      toast.success('Requirement deleted')
      onOpenChange(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't delete requirement"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {mode === 'contact' ? (
          <>
            <DialogHeader>
              <DialogTitle>Mark requirement as contacted</DialogTitle>
              <DialogDescription>
                {`Confirm that the client for "${requirement.title}" has been contacted. This locks editing for Admins and Viewers.`}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="requirement-contact-notes">
                Contact notes (optional)
              </Label>
              <Textarea
                id="requirement-contact-notes"
                placeholder="e.g. Client contacted, waiting for confirmation."
                rows={3}
                value={contactNotes}
                onChange={(event) => setContactNotes(event.target.value)}
                disabled={isBusy}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setMode('view')}
                disabled={isBusy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() =>
                  changeStatus('Contacted', contactNotes.trim() || null)
                }
                disabled={isBusy}
              >
                {statusMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PhoneCall className="size-4" />
                )}
                Confirm
              </Button>
            </DialogFooter>
          </>
        ) : mode === 'edit' ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit requirement</DialogTitle>
              <DialogDescription>
                Update the requirement details.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSaveEdit)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Requirement title</FormLabel>
                      <FormControl>
                        <Input disabled={isBusy} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="jdUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>JD link (optional)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://…"
                          disabled={isBusy}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="jdText"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Job description</FormLabel>
                      <FormControl>
                        <Textarea rows={6} disabled={isBusy} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid gap-2">
                  <Label htmlFor="requirement-edit-top-skills">
                    Top skills
                  </Label>
                  <TagInput
                    id="requirement-edit-top-skills"
                    values={editTopSkills}
                    onChange={(next) => {
                      setEditTopSkills(next)
                      if (next.length > 0) setTopSkillsError(undefined)
                    }}
                    placeholder="Type a skill and press Enter…"
                    disabled={isBusy}
                  />
                  {topSkillsError && (
                    <p className="text-destructive text-sm">{topSkillsError}</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="requirement-edit-optional-skills">
                    Optional skills
                  </Label>
                  <TagInput
                    id="requirement-edit-optional-skills"
                    values={editOptionalSkills}
                    onChange={setEditOptionalSkills}
                    placeholder="Type a skill and press Enter…"
                    disabled={isBusy}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="requirement-edit-target-companies">
                    Target companies
                  </Label>
                  <TagInput
                    id="requirement-edit-target-companies"
                    values={editTargetCompanies}
                    onChange={setEditTargetCompanies}
                    placeholder="Type a company and press Enter…"
                    disabled={isBusy}
                  />
                </div>
                {canManageLifecycle && (
                  <FormField
                    control={form.control}
                    name="contactNotes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact notes</FormLabel>
                        <FormControl>
                          <Textarea rows={3} disabled={isBusy} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setMode('view')}
                    disabled={isBusy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isBusy}>
                    {updateMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    Save changes
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{requirement.title}</DialogTitle>
              <DialogDescription className="flex items-center gap-2">
                <RequirementStatusBadge status={requirement.status} />
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Created by</p>
                <UserLine user={requirement.createdBy} />
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Created</p>
                <p className="text-foreground">
                  {formatDate(requirement.createdAt)}
                </p>
              </div>
              {requirement.hasFullDetails && requirement.contactedBy && (
                <>
                  <div>
                    <p className="text-muted-foreground text-xs">
                      Contacted by
                    </p>
                    <UserLine user={requirement.contactedBy} />
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Contacted</p>
                    <p className="text-foreground">
                      {requirement.contactedAt
                        ? formatDate(requirement.contactedAt)
                        : '—'}
                    </p>
                  </div>
                </>
              )}
            </div>

            {requirement.hasFullDetails ? (
              <div className="space-y-4">
                {requirement.jdUrl && (
                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      JD link
                    </p>
                    <a
                      href={requirement.jdUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
                    >
                      Open JD
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                )}
                {requirement.jdText && (
                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      Job description
                    </p>
                    <div className="border-border bg-muted/30 max-h-64 overflow-y-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">
                      {requirement.jdText}
                    </div>
                  </div>
                )}
                <ChipList label="Top skills" values={requirement.topSkills} />
                <ChipList
                  label="Optional skills"
                  values={requirement.optionalSkills}
                />
                <ChipList
                  label="Target companies"
                  values={requirement.targetCompanies}
                />
                {requirement.contactNotes && (
                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      Contact notes
                    </p>
                    <div className="border-border bg-muted/30 rounded-lg border p-3 text-sm whitespace-pre-wrap">
                      {requirement.contactNotes}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // Viewer + post-Contacted: the server sent only the summary,
              // so this is genuinely all there is to show.
              <p className="text-muted-foreground text-sm">
                This requirement is being handled by the hiring team. Full
                details are no longer visible once a requirement has been
                contacted.
              </p>
            )}

            <DialogFooter className="flex-wrap gap-2">
              {canDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="text-destructive sm:mr-auto"
                      disabled={isBusy}
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete requirement?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {`"${requirement.title}" and its contact history will be permanently removed. This cannot be undone.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete}>
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              {canManageLifecycle && (
                <Select
                  value={requirement.status}
                  onValueChange={(value) =>
                    changeStatus(value as RequirementStatus)
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger className="w-40" aria-label="Change status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIREMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={startEdit}
                  disabled={isBusy}
                >
                  <Pencil className="size-4" />
                  Edit
                </Button>
              )}
              {canManageLifecycle && requirement.status === 'Pending' && (
                <Button
                  type="button"
                  onClick={() => setMode('contact')}
                  disabled={isBusy}
                >
                  <PhoneCall className="size-4" />
                  Mark as Contacted
                </Button>
              )}
              {canManageLifecycle && requirement.status === 'Contacted' && (
                <Button
                  type="button"
                  onClick={() => changeStatus('In Progress')}
                  disabled={isBusy}
                >
                  {statusMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  Move to In Progress
                </Button>
              )}
              {canManageLifecycle && requirement.status === 'In Progress' && (
                <Button
                  type="button"
                  onClick={() => changeStatus('Completed')}
                  disabled={isBusy}
                >
                  {statusMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Mark Completed
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
