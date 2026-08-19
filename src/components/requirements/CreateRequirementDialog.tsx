import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'

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
import { TagInput } from '@/components/requirements/TagInput'
import { useCreateRequirement } from '@/hooks/useRequirements'
import { getErrorMessage } from '@/lib/errors'

const createSchema = z
  .object({
    title: z.string().min(1, 'Requirement title is required'),
    jdUrl: z
      .string()
      .trim()
      .refine((value) => !value || /^https?:\/\//i.test(value), {
        message: 'JD link must start with http:// or https://',
      }),
    jdText: z.string(),
  })
  .refine((value) => value.jdText.trim() || value.jdUrl.trim(), {
    message: 'Provide a job description, a JD link, or both.',
    path: ['jdText'],
  })

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

  const [topSkills, setTopSkills] = useState<string[]>([])
  const [optionalSkills, setOptionalSkills] = useState<string[]>([])
  const [targetCompanies, setTargetCompanies] = useState<string[]>([])
  const [topSkillsError, setTopSkillsError] = useState<string | undefined>()

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { title: '', jdUrl: '', jdText: '' },
  })

  function resetAll() {
    form.reset()
    setTopSkills([])
    setOptionalSkills([])
    setTargetCompanies([])
    setTopSkillsError(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next && !createMutation.isPending) resetAll()
    onOpenChange(next)
  }

  async function onSubmit(values: CreateFormValues) {
    // Chip lists live outside react-hook-form, so the required rule is
    // checked by hand — same pattern as the Upload dialog's file errors.
    // The Edge Function enforces it again server-side regardless.
    if (topSkills.length === 0) {
      setTopSkillsError('Add at least one top skill.')
      return
    }
    try {
      await createMutation.mutateAsync({
        title: values.title,
        jdText: values.jdText.trim() || null,
        jdUrl: values.jdUrl.trim() || null,
        topSkills,
        optionalSkills,
        targetCompanies,
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create requirement</DialogTitle>
          <DialogDescription>
            Submit a job requirement with its JD text, a JD link, or both.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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

            <FormField
              control={form.control}
              name="jdText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Job description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Paste the full job description…"
                      rows={6}
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-2">
              <Label htmlFor="requirement-top-skills">Top skills</Label>
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

            <div className="grid gap-2">
              <Label htmlFor="requirement-optional-skills">
                Optional skills
              </Label>
              <TagInput
                id="requirement-optional-skills"
                values={optionalSkills}
                onChange={setOptionalSkills}
                placeholder="Type a skill and press Enter…"
                disabled={isSubmitting}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="requirement-target-companies">
                Target companies
              </Label>
              <TagInput
                id="requirement-target-companies"
                values={targetCompanies}
                onChange={setTargetCompanies}
                placeholder="Type a company and press Enter…"
                disabled={isSubmitting}
              />
            </div>

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
