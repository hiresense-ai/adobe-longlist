import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  History,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { ActionBadge } from '@/components/status/ActionBadge'
import { useActionLogs } from '@/hooks/useActionLogs'
import { useDashboards } from '@/hooks/useDashboards'
import { useAssignableUsers } from '@/hooks/useAdminUsers'
import { ACTION_LIST } from '@/config/actionConfig'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/utils/date'
import type { CandidateAction } from '@/types'

const PAGE_SIZE = 25

const DATE_FILTERS = ['Today', 'This Week', 'This Month', 'All Time'] as const
type DateFilter = (typeof DATE_FILTERS)[number]

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function startOfWeek(): Date {
  const today = startOfToday()
  // getDay(): Sunday = 0 … Saturday = 6; the week starts Monday, matching
  // JD Analytics' own date-filter convention.
  const daysSinceMonday = (today.getDay() + 6) % 7
  today.setDate(today.getDate() - daysSinceMonday)
  return today
}

function startOfMonth(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

/** [dateFrom, dateTo) window for the selected filter, in ISO — undefined
 * for both when "All Time" (no filtering at all). Always based on
 * changed_at, computed the same "local calendar day/week/month" way JD
 * Analytics computes Today/This Week, never on any candidate/dashboard/
 * requirement date. */
function dateRangeFor(filter: DateFilter): {
  dateFrom?: string
  dateTo?: string
} {
  if (filter === 'All Time') return {}
  const start =
    filter === 'Today'
      ? startOfToday()
      : filter === 'This Week'
        ? startOfWeek()
        : startOfMonth()
  const end = new Date(start)
  if (filter === 'Today') end.setDate(end.getDate() + 1)
  else if (filter === 'This Week') end.setDate(end.getDate() + 7)
  else end.setMonth(end.getMonth() + 1)
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
}

/** email beneath the name, only when a name exists — same convention as
 * DashboardAnalyticsDialog's UserRow, so an identifier is never shown
 * twice. */
function ChangedByCell({
  name,
  email,
}: {
  name: string | null
  email: string | null
}) {
  const primary = name || email
  if (!primary) return <span className="text-muted-foreground">—</span>
  return (
    <div className="min-w-0">
      <p className="text-foreground truncate">{primary}</p>
      {name && email && (
        <p className="text-muted-foreground truncate text-xs">{email}</p>
      )}
    </div>
  )
}

/**
 * Action Logs — Super-Admin-only audit trail of candidate Action changes
 * (candidate_action_logs). Every row comes from the action-logs Edge
 * Function, which is the ONLY way to read that table (no client-reachable
 * RLS policy exists on it at all) and independently re-verifies the caller
 * is a Super Admin on every call — this page's own route guard
 * (SuperAdminRoute) and nav visibility (canViewActionLogs) are UX
 * conveniences, not the boundary.
 *
 * Unlike JD Analytics (which fetches everything once and filters/sorts/
 * paginates client-side over an already-small set), every filter change,
 * sort, and page turn here hits the network — the audit log has no upper
 * bound on size, so loading it all up front would only get slower over
 * time. See the Edge Function's own module comment for the same point.
 */
export function ActionLogs() {
  const [searchParams] = useSearchParams()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [dashboardId, setDashboardId] = useState(
    searchParams.get('dashboardId') ?? '',
  )
  const [changedBy, setChangedBy] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilter>('All Time')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  // Debounce the search box — every other filter already only fires on a
  // deliberate click/selection, but typing a name shouldn't hit the
  // network once per keystroke.
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timeout)
  }, [searchInput])

  // Any filter/search/sort change starts back at page 1 — this page's own
  // pagination, entirely independent of the Dashboard Candidates table's
  // (a different page, a different iframe, a different query key).
  // Adjusting state during render (React's own sanctioned pattern for
  // "reset state when a dependency changes" — see useDashboardStatusBridge's
  // identical heightForId reset) rather than a useEffect, which would cause
  // an extra, avoidable render.
  const filterKey = JSON.stringify([
    search,
    dashboardId,
    changedBy,
    actionFilter,
    dateFilter,
    sortDir,
  ])
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey)
    setPage(1)
  }

  const { dateFrom, dateTo } = dateRangeFor(dateFilter)

  const { data, isLoading, isError, error, refetch, isPlaceholderData } =
    useActionLogs({
      search: search || undefined,
      dashboardId: dashboardId || undefined,
      changedBy: changedBy || undefined,
      action: (actionFilter || undefined) as CandidateAction | undefined,
      dateFrom,
      dateTo,
      page,
      pageSize: PAGE_SIZE,
      sortDir,
    })

  const { data: dashboards } = useDashboards()
  const { data: users } = useAssignableUsers(true)

  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-foreground text-2xl font-semibold">
          Candidate Action Logs
        </h1>
        <p className="text-muted-foreground text-sm">
          Audit history of candidate action changes.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1 basis-56">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search candidates..."
            className="h-9 pl-9"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>

        <Select
          value={dashboardId || 'all'}
          onValueChange={(value) =>
            setDashboardId(value === 'all' ? '' : value)
          }
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="All Dashboards" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Dashboards</SelectItem>
            {(dashboards ?? []).map((dashboard) => (
              <SelectItem key={dashboard.id} value={dashboard.id}>
                {dashboard.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={changedBy || 'all'}
          onValueChange={(value) => setChangedBy(value === 'all' ? '' : value)}
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All Users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Users</SelectItem>
            {(users ?? []).map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name || user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={actionFilter || 'all'}
          onValueChange={(value) =>
            setActionFilter(value === 'all' ? '' : value)
          }
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="All Actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            {ACTION_LIST.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-wrap items-center gap-1.5">
          {DATE_FILTERS.map((filter) => (
            <Button
              key={filter}
              type="button"
              size="sm"
              variant={dateFilter === filter ? 'default' : 'outline'}
              onClick={() => setDateFilter(filter)}
            >
              {filter}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load Action Logs"
          description={getErrorMessage(
            error,
            'Please check your connection and try again.',
          )}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && (data?.data.length ?? 0) === 0 && (
        <EmptyState
          icon={History}
          title="No candidate action changes found"
          description="Nothing matches the current filters."
        />
      )}

      {!isLoading && !isError && (data?.data.length ?? 0) > 0 && (
        <>
          <div
            className={`border-border bg-card shadow-soft overflow-hidden rounded-2xl border transition-opacity ${
              isPlaceholderData ? 'opacity-60' : ''
            }`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead>
                  <tr className="border-border bg-muted/50 border-b text-xs">
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      <button
                        type="button"
                        onClick={() =>
                          setSortDir((dir) => (dir === 'desc' ? 'asc' : 'desc'))
                        }
                        className="hover:text-foreground text-foreground inline-flex items-center gap-1 transition-colors"
                        aria-label="Sort by Date & Time"
                      >
                        Date &amp; Time
                        {sortDir === 'desc' ? (
                          <ArrowDown className="size-3.5" />
                        ) : sortDir === 'asc' ? (
                          <ArrowUp className="size-3.5" />
                        ) : (
                          <ArrowUpDown className="size-3.5" />
                        )}
                      </button>
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Candidate
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Dashboard / JD
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Previous Action
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      New Action
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Changed By
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {(data?.data ?? []).map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-muted/40 transition-colors duration-150"
                    >
                      <td className="text-muted-foreground px-2 py-3 pl-4 whitespace-nowrap">
                        {formatDateTime(row.changedAt)}
                      </td>
                      <td className="text-foreground max-w-48 truncate px-2 py-3">
                        {row.candidateName ?? '—'}
                      </td>
                      <td className="text-muted-foreground max-w-48 truncate px-2 py-3">
                        {row.dashboardTitle ?? '—'}
                      </td>
                      <td className="px-2 py-3">
                        {row.previousAction ? (
                          <ActionBadge action={row.previousAction} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        {row.newAction ? (
                          <ActionBadge action={row.newAction} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 pr-4">
                        <ChangedByCell
                          name={row.changedByName}
                          email={row.changedByEmail}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {total} {total === 1 ? 'record' : 'records'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <span className="text-muted-foreground text-sm tabular-nums">
                Page {page} of {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
