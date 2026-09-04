import { useMemo, useState } from 'react'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
import { useDashboards } from '@/hooks/useDashboards'
import { useAuth } from '@/hooks/useAuth'
import { getErrorMessage } from '@/lib/errors'
import {
  canDeleteRequirements,
  canEditRequirement,
  canManageRequirementLifecycle,
} from '@/lib/permissions'
import { formatDate } from '@/utils/date'
import {
  REQUIREMENT_ROLE_TYPES,
  REQUIREMENT_STATUSES,
  roleTypeLabel,
  type Requirement,
  type RequirementRoleType,
  type RequirementStatus,
  type RequirementUserRef,
} from '@/services/requirements.service'

/**
 * Edit schema, parameterized on whether the requirement already carries
 * the detail fields. New-era requirements (`requireDetails`) must keep
 * them filled; requirements created before the fields existed may leave
 * them blank (blank = unchanged, the update payload simply omits them) —
 * but anything the user DOES enter must be valid and pair-consistent.
 */
function makeEditSchema(requireDetails: boolean) {
  return z
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
      relevantExperience: z.string().trim(),
      totalExperience: z.string().trim(),
      roleType: z.string(),
      idealCandidate: z
        .string()
        .max(2000, 'Ideal candidate description is too long.'),
      notAFit: z.string().max(2000, 'Not-a-fit notes are too long.'),
    })
    .refine((value) => value.jdText.trim() || value.jdUrl.trim(), {
      message: 'A requirement must keep a job description or a JD link.',
      path: ['jdText'],
    })
    .superRefine((value, ctx) => {
      const entries = [
        {
          raw: value.relevantExperience,
          path: 'relevantExperience',
          label: 'Relevant experience',
        },
        {
          raw: value.totalExperience,
          path: 'totalExperience',
          label: 'Total experience',
        },
      ] as const
      // Once either experience is present (or the row already has them),
      // both are needed — a lone value can't satisfy the pair rule.
      const experienceRequired =
        requireDetails || entries.some((entry) => entry.raw !== '')
      for (const { raw, path, label } of entries) {
        if (raw === '') {
          if (experienceRequired) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [path],
              message: `${label} is required.`,
            })
          }
        } else if (!Number.isFinite(Number(raw))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `${label} must be a number of years.`,
          })
        } else if (Number(raw) < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `${label} cannot be negative.`,
          })
        }
      }
      const relevant = Number(value.relevantExperience)
      const total = Number(value.totalExperience)
      if (
        value.relevantExperience !== '' &&
        value.totalExperience !== '' &&
        Number.isFinite(relevant) &&
        Number.isFinite(total) &&
        total < relevant
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalExperience'],
          message:
            'Total experience must be greater than or equal to relevant experience.',
        })
      }
      if (requireDetails && !value.roleType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roleType'],
          message: 'Select a role type.',
        })
      }
    })
}

type EditFormValues = z.infer<ReturnType<typeof makeEditSchema>>

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
  // '' = not linked. Super-Admin-only control; seeded in startEdit.
  const [editDashboardId, setEditDashboardId] = useState('')
  // Same cached query the Dashboards page uses; for the Super Admin who
  // sees this control, that list is every dashboard.
  const { data: dashboards } = useDashboards()

  const isOwner = Boolean(user && requirement.createdBy?.id === user.id)
  const isPending = requirement.status === 'Pending'
  const canEdit = canEditRequirement(role, { isOwner, isPending })
  const canManageLifecycle = canManageRequirementLifecycle(role)
  const canDelete = canDeleteRequirements(role)
  const isBusy =
    updateMutation.isPending ||
    statusMutation.isPending ||
    deleteMutation.isPending

  // Old rows (pre-detail-fields) may keep their blanks; anything newer
  // must keep the required detail fields filled through an edit.
  const requireDetails =
    requirement.relevantExperience != null ||
    requirement.totalExperience != null ||
    requirement.roleType != null

  const editSchema = useMemo(
    () => makeEditSchema(requireDetails),
    [requireDetails],
  )

  const editDefaults = (): EditFormValues => ({
    title: requirement.title,
    jdUrl: requirement.jdUrl ?? '',
    jdText: requirement.jdText ?? '',
    contactNotes: requirement.contactNotes ?? '',
    relevantExperience:
      requirement.relevantExperience != null
        ? String(requirement.relevantExperience)
        : '',
    totalExperience:
      requirement.totalExperience != null
        ? String(requirement.totalExperience)
        : '',
    roleType: requirement.roleType ?? '',
    idealCandidate: requirement.idealCandidate ?? '',
    notAFit: requirement.notAFit ?? '',
  })

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: editDefaults(),
  })

  function startEdit() {
    form.reset(editDefaults())
    setEditTopSkills(requirement.topSkills ?? [])
    setEditOptionalSkills(requirement.optionalSkills ?? [])
    setEditTargetCompanies(requirement.targetCompanies ?? [])
    setTopSkillsError(undefined)
    setEditDashboardId(requirement.dashboardId ?? '')
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
      setTopSkillsError('Add at least one must-have skill.')
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
        // Blank on an old (pre-detail-fields) row means "unchanged" — the
        // keys are omitted so nothing is invented for legacy data.
        ...(values.relevantExperience.trim() !== ''
          ? { relevantExperience: Number(values.relevantExperience) }
          : {}),
        ...(values.totalExperience.trim() !== ''
          ? { totalExperience: Number(values.totalExperience) }
          : {}),
        ...(values.roleType
          ? { roleType: values.roleType as RequirementRoleType }
          : {}),
        idealCandidate: values.idealCandidate.trim() || null,
        notAFit: values.notAFit.trim() || null,
        // contactNotes/dashboardId keys are only ever sent by a Super
        // Admin — the Edge Function rejects either key outright from
        // anyone else.
        ...(canManageLifecycle
          ? {
              contactNotes: values.contactNotes.trim() || null,
              dashboardId: editDashboardId || null,
            }
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
                    Must-have skills
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
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="relevantExperience"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Relevant experience</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              step={0.5}
                              placeholder="e.g. 3"
                              disabled={isBusy}
                              {...field}
                            />
                            <span className="text-muted-foreground shrink-0 text-sm">
                              years
                            </span>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="totalExperience"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Total experience</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              step={0.5}
                              placeholder="e.g. 5"
                              disabled={isBusy}
                              {...field}
                            />
                            <span className="text-muted-foreground shrink-0 text-sm">
                              years
                            </span>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="roleType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role type</FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={isBusy}
                          className="flex flex-col gap-2 pt-1"
                        >
                          {REQUIREMENT_ROLE_TYPES.map((roleType) => (
                            <div
                              key={roleType.value}
                              className="flex items-center gap-2"
                            >
                              <RadioGroupItem
                                value={roleType.value}
                                id={`requirement-edit-role-${roleType.value}`}
                              />
                              <Label
                                htmlFor={`requirement-edit-role-${roleType.value}`}
                                className="font-normal"
                              >
                                {roleType.label}
                              </Label>
                            </div>
                          ))}
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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
                <FormField
                  control={form.control}
                  name="idealCandidate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ideal candidate (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Describe the ideal candidate profile…"
                          rows={3}
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
                  name="notAFit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Not a fit (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Describe anything that is not required or would not be a good fit…"
                          rows={3}
                          disabled={isBusy}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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
                {/* Super-Admin-only, like contact notes: links this
                    requirement to its JD dashboard so JD Analytics can
                    show the completion date on that dashboard's row. Lives
                    outside react-hook-form (simple select, seeded in
                    startEdit). Native select styled like the app's inputs
                    — options are the dashboards this Super Admin can
                    already see (all of them). */}
                {canManageLifecycle && (
                  <div className="grid gap-2">
                    <Label htmlFor="requirement-linked-dashboard">
                      Linked JD dashboard
                    </Label>
                    <select
                      id="requirement-linked-dashboard"
                      className="border-input bg-background text-foreground focus-visible:ring-ring h-9 rounded-md border px-3 text-sm shadow-sm outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
                      value={editDashboardId}
                      onChange={(event) =>
                        setEditDashboardId(event.target.value)
                      }
                      disabled={isBusy}
                    >
                      <option value="">Not linked</option>
                      {(dashboards ?? []).map((dashboard) => (
                        <option key={dashboard.id} value={dashboard.id}>
                          {dashboard.title}
                        </option>
                      ))}
                    </select>
                  </div>
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
              {/* The real completion timestamp (stamped server-side on the
                  transition into Completed) — shown only while the CURRENT
                  status is Completed, so a reopened requirement drops it.
                  Part of the summary shape, so every role that can see the
                  row sees it. */}
              {requirement.status === 'Completed' &&
                requirement.completedAt && (
                  <div>
                    <p className="text-muted-foreground text-xs">Completed</p>
                    <p className="text-foreground">
                      {formatDate(requirement.completedAt)}
                    </p>
                  </div>
                )}
              {/* Shown when linked AND this viewer's dashboard list can
                  resolve the title (a viewer not assigned to the linked
                  dashboard simply doesn't see the entry — no id leaks). */}
              {requirement.dashboardId &&
                (dashboards ?? []).some(
                  (d) => d.id === requirement.dashboardId,
                ) && (
                  <div>
                    <p className="text-muted-foreground text-xs">Linked JD</p>
                    <p className="text-foreground truncate">
                      {
                        (dashboards ?? []).find(
                          (d) => d.id === requirement.dashboardId,
                        )?.title
                      }
                    </p>
                  </div>
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
                <ChipList
                  label="Must-have skills"
                  values={requirement.topSkills}
                />
                <ChipList
                  label="Optional skills"
                  values={requirement.optionalSkills}
                />
                {(requirement.relevantExperience != null ||
                  requirement.totalExperience != null ||
                  requirement.roleType) && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    {requirement.relevantExperience != null && (
                      <div>
                        <p className="text-muted-foreground text-xs">
                          Relevant experience
                        </p>
                        <p className="text-foreground">
                          {requirement.relevantExperience} years
                        </p>
                      </div>
                    )}
                    {requirement.totalExperience != null && (
                      <div>
                        <p className="text-muted-foreground text-xs">
                          Total experience
                        </p>
                        <p className="text-foreground">
                          {requirement.totalExperience} years
                        </p>
                      </div>
                    )}
                    {requirement.roleType && (
                      <div>
                        <p className="text-muted-foreground text-xs">
                          Role type
                        </p>
                        <p className="text-foreground">
                          {roleTypeLabel(requirement.roleType)}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                <ChipList
                  label="Target companies"
                  values={requirement.targetCompanies}
                />
                {requirement.idealCandidate && (
                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      Ideal candidate
                    </p>
                    <div className="border-border bg-muted/30 rounded-lg border p-3 text-sm whitespace-pre-wrap">
                      {requirement.idealCandidate}
                    </div>
                  </div>
                )}
                {requirement.notAFit && (
                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      Not a fit
                    </p>
                    <div className="border-border bg-muted/30 rounded-lg border p-3 text-sm whitespace-pre-wrap">
                      {requirement.notAFit}
                    </div>
                  </div>
                )}
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
