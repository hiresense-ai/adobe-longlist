import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'

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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { TagInput } from '@/components/requirements/TagInput'
import { useCreateRequirement } from '@/hooks/useRequirements'
import { getErrorMessage } from '@/lib/errors'
import {
  REQUIREMENT_ROLE_TYPES,
  type RequirementRoleType,
} from '@/services/requirements.service'

/** Years-of-experience input: required, numeric, non-negative — decimals
 * like 3.5 are fine. Kept as a string in the form (HTML inputs are
 * strings) and converted on submit; the Edge Function re-validates. */
function experienceField(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((value) => Number.isFinite(Number(value)), {
      message: `${label} must be a number of years.`,
    })
    .refine((value) => Number(value) >= 0, {
      message: `${label} cannot be negative.`,
    })
}

const createSchema = z
  .object({
    title: z.string().min(1, 'Requirement title is required'),
    // The ONLY optional field on this form — everything else must be
    // filled in before Create succeeds (the Edge Function enforces the
    // same set server-side).
    jdUrl: z
      .string()
      .trim()
      .refine((value) => !value || /^https?:\/\//i.test(value), {
        message: 'JD link must start with http:// or https://',
      }),
    jdText: z.string().trim().min(1, 'Job description is required.'),
    relevantExperience: experienceField('Relevant experience'),
    totalExperience: experienceField('Total experience'),
    roleType: z.string().min(1, 'Select a role type.'),
    idealCandidate: z
      .string()
      .trim()
      .min(1, 'Ideal candidate description is required.')
      .max(2000, 'Ideal candidate description is too long.'),
    notAFit: z
      .string()
      .trim()
      .min(1, 'Not-a-fit notes are required.')
      .max(2000, 'Not-a-fit notes are too long.'),
  })
  .refine(
    (value) => {
      const relevant = Number(value.relevantExperience)
      const total = Number(value.totalExperience)
      // Only compare once both parse — each field's own rules report
      // non-numeric input with a more specific message.
      return (
        !Number.isFinite(relevant) ||
        !Number.isFinite(total) ||
        total >= relevant
      )
    },
    {
      message:
        'Total experience must be greater than or equal to relevant experience.',
      path: ['totalExperience'],
    },
  )

type CreateFormValues = z.infer<typeof createSchema>

/** Open to every role — a new requirement always starts as Pending, owned
 * by its creator (the Edge Function ignores anything else a request might
 * claim). */
export function CreateRequirementDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const createMutation = useCreateRequirement()

  // Displayed as "Must-Have Skills" — internally this is still the
  // top_skills architecture, unchanged (rename is a label change only).
  const [topSkills, setTopSkills] = useState<string[]>([])
  const [optionalSkills, setOptionalSkills] = useState<string[]>([])
  const [targetCompanies, setTargetCompanies] = useState<string[]>([])
  const [topSkillsError, setTopSkillsError] = useState<string | undefined>()
  const [optionalSkillsError, setOptionalSkillsError] = useState<
    string | undefined
  >()
  const [targetCompaniesError, setTargetCompaniesError] = useState<
    string | undefined
  >()

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      title: '',
      jdUrl: '',
      jdText: '',
      relevantExperience: '',
      totalExperience: '',
      roleType: '',
      idealCandidate: '',
      notAFit: '',
    },
  })

  function resetAll() {
    form.reset()
    setTopSkills([])
    setOptionalSkills([])
    setTargetCompanies([])
    setTopSkillsError(undefined)
    setOptionalSkillsError(undefined)
    setTargetCompaniesError(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next && !createMutation.isPending) resetAll()
    onOpenChange(next)
  }

  // Chip lists live outside react-hook-form, so their required rules are
  // checked by hand — same pattern as the Upload dialog's file errors. All
  // three are validated together (not first-failure-only) so every missing
  // list shows its error at once, and this also runs when the zod fields
  // fail (handleSubmit's invalid path) so a fully empty submit surfaces
  // EVERY missing field in one pass. The Edge Function enforces the same
  // rules again server-side regardless.
  function validateChipLists() {
    let valid = true
    if (topSkills.length === 0) {
      setTopSkillsError('Add at least one must-have skill.')
      valid = false
    }
    if (optionalSkills.length === 0) {
      setOptionalSkillsError('Add at least one optional skill.')
      valid = false
    }
    if (targetCompanies.length === 0) {
      setTargetCompaniesError('Add at least one target company.')
      valid = false
    }
    return valid
  }

  async function onSubmit(values: CreateFormValues) {
    if (!validateChipLists()) return
    try {
      await createMutation.mutateAsync({
        title: values.title,
        jdText: values.jdText.trim(),
        jdUrl: values.jdUrl.trim() || null,
        topSkills,
        optionalSkills,
        targetCompanies,
        relevantExperience: Number(values.relevantExperience),
        totalExperience: Number(values.totalExperience),
        roleType: values.roleType as RequirementRoleType,
        idealCandidate: values.idealCandidate.trim(),
        notAFit: values.notAFit.trim(),
      })
      toast.success(`${values.title} created`)
      resetAll()
      onOpenChange(false)
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't create requirement"))
    }
  }

  const isSubmitting = createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create requirement</DialogTitle>
          <DialogDescription>
            Submit a job requirement. Every field is required except the JD
            link.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit, validateChipLists)}
            className="space-y-4"
          >
            {/* Field pairs sit side by side from `sm` up purely to keep
                the dialog short — on narrow viewports every pair stacks
                back to a single column, preserving the same field order. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requirement title</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Adobe AEM Architect"
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
                name="jdUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>JD link (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://…"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="jdText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Job description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Paste the full job description…"
                      rows={4}
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <Label htmlFor="requirement-top-skills">Must-have skills</Label>
                <TagInput
                  id="requirement-top-skills"
                  values={topSkills}
                  onChange={(next) => {
                    setTopSkills(next)
                    if (next.length > 0) setTopSkillsError(undefined)
                  }}
                  placeholder="Type a skill and press Enter…"
                  disabled={isSubmitting}
                />
                {topSkillsError && (
                  <p className="text-destructive text-sm">{topSkillsError}</p>
                )}
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="requirement-optional-skills">
                  Optional skills
                </Label>
                <TagInput
                  id="requirement-optional-skills"
                  values={optionalSkills}
                  onChange={(next) => {
                    setOptionalSkills(next)
                    if (next.length > 0) setOptionalSkillsError(undefined)
                  }}
                  placeholder="Type a skill and press Enter…"
                  disabled={isSubmitting}
                />
                {optionalSkillsError && (
                  <p className="text-destructive text-sm">
                    {optionalSkillsError}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
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
                          disabled={isSubmitting}
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
                          disabled={isSubmitting}
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

            <div className="grid gap-4 sm:grid-cols-2">
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
                        disabled={isSubmitting}
                        className="flex flex-col gap-2 pt-1"
                      >
                        {REQUIREMENT_ROLE_TYPES.map((roleType) => (
                          <div
                            key={roleType.value}
                            className="flex items-center gap-2"
                          >
                            <RadioGroupItem
                              value={roleType.value}
                              id={`requirement-role-${roleType.value}`}
                            />
                            <Label
                              htmlFor={`requirement-role-${roleType.value}`}
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
              <div className="grid content-start gap-2">
                <Label htmlFor="requirement-target-companies">
                  Target companies
                </Label>
                <TagInput
                  id="requirement-target-companies"
                  values={targetCompanies}
                  onChange={(next) => {
                    setTargetCompanies(next)
                    if (next.length > 0) setTargetCompaniesError(undefined)
                  }}
                  placeholder="Type a company and press Enter…"
                  disabled={isSubmitting}
                />
                {targetCompaniesError && (
                  <p className="text-destructive text-sm">
                    {targetCompaniesError}
                  </p>
                )}
              </div>
            </div>

            <FormField
              control={form.control}
              name="idealCandidate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ideal candidate</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe the ideal candidate profile…"
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
              name="notAFit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Not a fit</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe anything that is not required or would not be a good fit…"
                      rows={3}
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                  <Plus className="size-4" />
                )}
                Create
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
