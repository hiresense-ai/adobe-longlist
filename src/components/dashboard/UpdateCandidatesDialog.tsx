import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDashboards } from '@/hooks/useDashboards'
import { useUpdateDashboardCandidates } from '@/hooks/useUpdateDashboardCandidates'
import { validateCsvFile } from '@/services/dashboardAdmin.service'
import type { UpdateDashboardCandidatesResult } from '@/services/dashboardAdmin.service'
import { getErrorMessage } from '@/lib/errors'

const STAGE_LABEL: Record<string, string> = {
  downloading: 'Downloading dashboard…',
  reading: 'Reading CSV…',
  merging: 'Merging candidates…',
  uploading: 'Uploading updated HTML…',
  saving: 'Updating dashboard…',
}

export function UpdateCandidatesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: dashboards } = useDashboards()
  const updateMutation = useUpdateDashboardCandidates()

  const [dashboardId, setDashboardId] = useState('')
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [csvError, setCsvError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{
    stage: string
    percent: number
  } | null>(null)
  const [result, setResult] = useState<UpdateDashboardCandidatesResult | null>(
    null,
  )

  const isSubmitting = updateMutation.isPending

  function resetAll() {
    setDashboardId('')
    setCsvFile(null)
    setCsvError(null)
    setProgress(null)
    setResult(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next && !isSubmitting) resetAll()
    onOpenChange(next)
  }

  async function handleMerge() {
    if (!dashboardId || !csvFile) return
    const error = validateCsvFile(csvFile)
    if (error) {
      setCsvError(error)
      return
    }
    setCsvError(null)

    const selected = dashboards?.find((d) => d.id === dashboardId)

    try {
      setProgress({ stage: 'downloading', percent: 5 })
      const mergeResult = await updateMutation.mutateAsync({
        dashboardId,
        csvFile,
        onProgress: (stage, percent) => setProgress({ stage, percent }),
      })
      setResult(mergeResult)
      setProgress(null)
      if (mergeResult.appendedCount > 0) {
        toast.success(
          `${mergeResult.appendedCount} new candidate${mergeResult.appendedCount === 1 ? '' : 's'} added to ${selected?.title ?? 'the dashboard'}`,
        )
      } else {
        toast.info('No new candidates to add — every row already existed')
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't update dashboard candidates"))
      setProgress(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="text-primary size-5" />
                Dashboard updated successfully
              </DialogTitle>
              <DialogDescription>
                {result.appendedCount > 0
                  ? 'New candidates have been appended to the existing dashboard.'
                  : "No new candidates were added — every row in the CSV matched a candidate that's already in the dashboard."}
              </DialogDescription>
            </DialogHeader>

            <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Existing candidates</dt>
                <dd className="text-lg font-semibold">
                  {result.existingCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">New candidates added</dt>
                <dd className="text-lg font-semibold">
                  {result.appendedCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Duplicates skipped</dt>
                <dd className="text-lg font-semibold">
                  {result.skippedCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Final total</dt>
                <dd className="text-lg font-semibold">
                  {result.finalTotal.toLocaleString()}
                </dd>
              </div>
            </dl>

            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Update candidates</DialogTitle>
              <DialogDescription>
                Append new candidates from a CSV into an existing dashboard.
                Existing candidates, actions, and layout are never changed.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="update-candidates-dashboard">Dashboard</Label>
                <Select
                  value={dashboardId}
                  onValueChange={setDashboardId}
                  disabled={isSubmitting}
                >
                  <SelectTrigger
                    id="update-candidates-dashboard"
                    className="w-full"
                  >
                    <SelectValue placeholder="Select a dashboard" />
                  </SelectTrigger>
                  <SelectContent>
                    {dashboards?.map((dashboard) => (
                      <SelectItem key={dashboard.id} value={dashboard.id}>
                        {dashboard.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="update-candidates-csv">
                  New candidates CSV
                </Label>
                <Input
                  id="update-candidates-csv"
                  type="file"
                  accept=".csv,text/csv"
                  disabled={isSubmitting}
                  onChange={(event) => {
                    setCsvFile(event.target.files?.[0] ?? null)
                    setCsvError(null)
                  }}
                />
                {csvFile && !csvError && (
                  <p className="text-muted-foreground text-xs">
                    Selected: {csvFile.name}
                  </p>
                )}
                {csvError && (
                  <p className="text-destructive text-sm">{csvError}</p>
                )}
              </div>

              {progress && (
                <div className="space-y-1.5">
                  <Progress value={progress.percent} />
                  <p className="text-muted-foreground text-xs">
                    {STAGE_LABEL[progress.stage] ?? 'Working…'}
                  </p>
                </div>
              )}
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
              <Button
                type="button"
                onClick={handleMerge}
                disabled={isSubmitting || !dashboardId || !csvFile}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Merge candidates
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
