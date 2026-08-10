import { useMemo, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { useAuth } from '@/hooks/useAuth'
import { useAssignableUsers } from '@/hooks/useAdminUsers'
import {
  useAssignDashboardUser,
  useDashboardAssignments,
  useUnassignDashboardUser,
} from '@/hooks/useDashboardAssignments'
import { assignableDashboardRoles, roleLabel } from '@/lib/permissions'
import { getErrorMessage } from '@/lib/errors'
import type { DashboardWithThumbnail } from '@/services/dashboards.service'

/**
 * Grant/revoke access to one dashboard. Only ever rendered for Admin/
 * Super Admin (see canManageDashboardAssignments) — the actual authorization
 * (which roles can be added, whether the caller may touch this dashboard at
 * all) is re-checked server-side on every call by the dashboard-assignments
 * Edge Function; this UI only decides what to offer.
 */
export function ManageAccessDialog({
  dashboard,
  open,
  onOpenChange,
}: {
  dashboard: Pick<DashboardWithThumbnail, 'id' | 'title'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useAuth()
  const callerRole = user?.role ?? 'viewer'
  const eligibleRoles = assignableDashboardRoles(callerRole)

  const {
    data: assignments,
    isLoading,
    isError,
    error,
  } = useDashboardAssignments(dashboard.id, open)
  const { data: allUsers } = useAssignableUsers(open)
  const assignMutation = useAssignDashboardUser(dashboard.id)
  const unassignMutation = useUnassignDashboardUser(dashboard.id)

  const [selectedUserId, setSelectedUserId] = useState('')

  const assignedIds = useMemo(
    () => new Set((assignments ?? []).map((a) => a.userId)),
    [assignments],
  )

  const eligibleToAdd = useMemo(
    () =>
      (allUsers ?? []).filter(
        (candidate) =>
          eligibleRoles.includes(candidate.role) &&
          !assignedIds.has(candidate.id),
      ),
    [allUsers, eligibleRoles, assignedIds],
  )

  async function handleAdd() {
    if (!selectedUserId) return
    try {
      await assignMutation.mutateAsync(selectedUserId)
      setSelectedUserId('')
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't grant access"))
    }
  }

  async function handleRemove(userId: string) {
    try {
      await unassignMutation.mutateAsync(userId)
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't remove access"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            {`Choose who can see "${dashboard.title}".`}
            {callerRole === 'admin' &&
              ' You can only grant or remove Viewer access.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        )}

        {isError && (
          <p className="text-destructive text-sm">
            {getErrorMessage(error, "Couldn't load current access.")}
          </p>
        )}

        {!isLoading && !isError && (
          <>
            <ScrollArea className="max-h-64">
              <div className="space-y-2 pr-3">
                {(assignments ?? []).length === 0 && (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    Nobody has access yet.
                  </p>
                )}
                {(assignments ?? []).map((assignment) => {
                  const isSelf = assignment.userId === user?.id
                  const canRemove =
                    callerRole === 'super_admin'
                      ? true
                      : assignment.role === 'viewer' && !isSelf
                  return (
                    <div
                      key={assignment.id}
                      className="border-border flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {assignment.name || assignment.email}
                          {isSelf && (
                            <span className="text-muted-foreground">
                              {' '}
                              (you)
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {assignment.email}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {roleLabel(assignment.role ?? 'viewer')}
                        </Badge>
                        {canRemove && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${assignment.email ?? 'user'}`}
                            disabled={unassignMutation.isPending}
                            onClick={() => handleRemove(assignment.userId)}
                          >
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>

            {eligibleRoles.length > 0 && (
              <div className="flex items-center gap-2 pt-2">
                <Select
                  value={selectedUserId}
                  onValueChange={setSelectedUserId}
                  disabled={assignMutation.isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Grant access to…" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleToAdd.length === 0 ? (
                      <div className="text-muted-foreground px-2 py-1.5 text-sm">
                        No eligible users left to add.
                      </div>
                    ) : (
                      eligibleToAdd.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {`${candidate.name || candidate.email} — ${roleLabel(candidate.role)}`}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  onClick={handleAdd}
                  disabled={!selectedUserId || assignMutation.isPending}
                >
                  {assignMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  Add
                </Button>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
