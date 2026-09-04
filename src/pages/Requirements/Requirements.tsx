import { useMemo, useState } from 'react'
import { ClipboardList, Eye, Plus, Search, ShieldX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { RequirementStatusBadge } from '@/components/requirements/RequirementStatusBadge'
import { CreateRequirementDialog } from '@/components/requirements/CreateRequirementDialog'
import { RequirementDetailsDialog } from '@/components/requirements/RequirementDetailsDialog'
import { useRequirements } from '@/hooks/useRequirements'
import {
  filterRequirements,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from '@/services/requirements.service'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/utils/date'

type StatusFilter = 'All' | RequirementStatus

/**
 * Requirements — job requirement / JD submissions with a Super-Admin-owned
 * lifecycle (Pending → Contacted → In Progress → Completed). The list this
 * page renders is already role-shaped by the requirements Edge Function:
 * a Viewer only ever receives their own requirements, and only summary
 * fields once one has been contacted — so every filter/search here
 * operates strictly over what the caller is allowed to see.
 */
export function Requirements() {
  const {
    data: requirements,
    isLoading,
    isError,
    error,
    refetch,
  } = useRequirements()

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const byStatus =
      statusFilter === 'All'
        ? (requirements ?? [])
        : (requirements ?? []).filter((r) => r.status === statusFilter)
    return filterRequirements(byStatus, query)
  }, [requirements, statusFilter, query])

  // Derived from the freshest list data, so the open dialog reflects a
  // just-saved edit or status change immediately after invalidation.
  const activeRequirement = useMemo(
    () => (requirements ?? []).find((r) => r.id === activeId) ?? null,
    [requirements, activeId],
  )

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-semibold">
            Requirements
          </h1>
          <p className="text-muted-foreground text-sm">
            Submit job requirements and track them from Pending to Completed.
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus className="size-4" />
          Add Requirement
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['All', ...REQUIREMENT_STATUSES] as StatusFilter[]).map(
            (status) => (
              <Button
                key={status}
                type="button"
                size="sm"
                variant={statusFilter === status ? 'default' : 'outline'}
                onClick={() => setStatusFilter(status)}
              >
                {status}
              </Button>
            ),
          )}
        </div>
        <div className="relative max-w-xs flex-1 basis-56">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search requirements..."
            className="h-9 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {isLoading && (
        <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load requirements"
          description={getErrorMessage(
            error,
            'Please check your connection and try again.',
          )}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && (requirements ?? []).length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="No requirements yet"
          description="Submit the first job requirement to get started."
          action={
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="size-4" />
              Add Requirement
            </Button>
          }
        />
      )}

      {!isLoading &&
        !isError &&
        (requirements ?? []).length > 0 &&
        filtered.length === 0 && (
          <EmptyState
            icon={ShieldX}
            title="No matches found"
            description={
              query
                ? `Nothing matches "${query}".`
                : `No ${statusFilter.toLowerCase()} requirements.`
            }
          />
        )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="border-border bg-card shadow-soft overflow-hidden rounded-2xl border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-border bg-muted/50 border-b text-xs">
                  <th className="text-muted-foreground px-4 py-3 font-medium">
                    Requirement
                  </th>
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Created By
                  </th>
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Created
                  </th>
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Status
                  </th>
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Completed
                  </th>
                  <th className="w-16 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {filtered.map((requirement) => (
                  <tr
                    key={requirement.id}
                    className="hover:bg-muted/40 transition-colors duration-150"
                  >
                    <td className="max-w-64 truncate px-4 py-3 font-medium">
                      {requirement.title}
                    </td>
                    <td className="px-2 py-3">
                      <span className="text-foreground block">
                        {requirement.createdBy?.name ||
                          requirement.createdBy?.email ||
                          'Unknown'}
                      </span>
                      {requirement.createdBy?.name && (
                        <span className="text-muted-foreground block truncate text-xs">
                          {requirement.createdBy.email}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-2 py-3">
                      {formatDate(requirement.createdAt)}
                    </td>
                    <td className="px-2 py-3">
                      <RequirementStatusBadge status={requirement.status} />
                    </td>
                    {/* Real completion timestamp only (stamped server-side
                        on the transition into Completed) — display gated on
                        the CURRENT status, so a reopened requirement shows
                        "—" again even though the historical stamp is kept.
                        Legacy rows completed before the stamp existed also
                        show "—", never a guessed date. */}
                    <td className="text-muted-foreground px-2 py-3">
                      {requirement.status === 'Completed' &&
                      requirement.completedAt
                        ? formatDate(requirement.completedAt)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        aria-label={`View ${requirement.title}`}
                        onClick={() => setActiveId(requirement.id)}
                      >
                        <Eye className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CreateRequirementDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
      />
      {activeRequirement && (
        <RequirementDetailsDialog
          requirement={activeRequirement}
          open={Boolean(activeRequirement)}
          onOpenChange={(open) => {
            if (!open) setActiveId(null)
          }}
        />
      )}
    </div>
  )
}
