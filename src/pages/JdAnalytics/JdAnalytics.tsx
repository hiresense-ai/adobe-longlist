import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChartColumn,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { useJdAnalytics } from '@/hooks/useDashboardAnalytics'
import {
  aggregateJdMetrics,
  computeJdMetrics,
  formatJdRatio,
  type JdAnalyticsRow,
  type JdMetrics,
} from '@/services/dashboardAnalytics.service'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/utils/date'

/** Which creation window a row must fall in. "This Week" is the CURRENT
 * calendar week starting Monday 00:00 in the viewer's local timezone —
 * matching how the rest of the app treats dates as local (formatDate). */
const DATE_FILTERS = ['Today', 'This Week', 'All Time'] as const
type DateFilter = (typeof DATE_FILTERS)[number]

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function startOfWeek(): Date {
  const today = startOfToday()
  // getDay(): Sunday = 0 … Saturday = 6; the week starts Monday.
  const daysSinceMonday = (today.getDay() + 6) % 7
  today.setDate(today.getDate() - daysSinceMonday)
  return today
}

function matchesDateFilter(createdAt: string, filter: DateFilter): boolean {
  if (filter === 'All Time') return true
  const created = new Date(createdAt)
  return created >= (filter === 'Today' ? startOfToday() : startOfWeek())
}

type SortKey = 'title' | 'createdAt' | 'pending' | 'ssHs' | 'srHs' | 'ratio'

interface RowWithMetrics {
  row: JdAnalyticsRow
  metrics: JdMetrics
}

function sortValue(entry: RowWithMetrics, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return entry.row.title.toLowerCase()
    case 'createdAt':
      return new Date(entry.row.createdAt).getTime()
    case 'pending':
      // Nulls (unreadable candidate totals) sort last in either direction.
      return entry.metrics.pending ?? -1
    case 'ssHs':
      return entry.metrics.ssHs
    case 'srHs':
      return entry.metrics.srHs
    case 'ratio':
      return entry.metrics.ratio ?? -1
  }
}

function SortableHeader({
  label,
  sort,
  sortKey,
  sortDir,
  onToggle,
  align = 'left',
}: {
  label: string
  sort: SortKey
  sortKey: SortKey
  sortDir: 1 | -1
  onToggle: (key: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sortKey === sort
  const Icon = active ? (sortDir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className="text-muted-foreground px-2 py-3 font-medium">
      <button
        type="button"
        onClick={() => onToggle(sort)}
        className={`hover:text-foreground inline-flex items-center gap-1 transition-colors ${
          align === 'right' ? 'w-full justify-end' : ''
        } ${active ? 'text-foreground' : ''}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className="size-3.5" />
      </button>
    </th>
  )
}

/**
 * JD Analytics — one high-level table over every JD/dashboard the caller
 * may see, so nobody has to open dashboards one by one. The data arrives
 * as ONE aggregated response from the dashboard-analytics Edge Function
 * (`overview`), which enforces the same access rule as the existing
 * per-dashboard Analytics dialog: Super Admin sees all dashboards, Admin
 * and Viewer only the ones assigned to them. SS.HS / SR.HS / Pending are
 * classified in computeJdMetrics from the same action breakdown the
 * Analytics dialog renders, so the two views always agree.
 */
export function JdAnalytics() {
  const { data, isLoading, isError, error, refetch } = useJdAnalytics()

  const [dateFilter, setDateFilter] = useState<DateFilter>('All Time')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)

  const rows = useMemo<RowWithMetrics[]>(
    () =>
      (data?.rows ?? []).map((row) => ({
        row,
        metrics: computeJdMetrics(row),
      })),
    [data],
  )

  // Date filtering alone — the aggregate summary is computed over THIS set
  // (every JD matching the selected date window, exactly as the product
  // rule states), so the name search below narrows only the table, never
  // the totals. All rows are already in memory from the one batched
  // overview response, so the summary is pagination-proof by construction
  // (there is no pagination — the table always renders the full set).
  const dateFiltered = useMemo(
    () =>
      rows.filter((entry) =>
        matchesDateFilter(entry.row.createdAt, dateFilter),
      ),
    [rows, dateFilter],
  )

  const summary = useMemo(
    () => aggregateJdMetrics(dateFiltered.map((entry) => entry.metrics)),
    [dateFiltered],
  )

  const visible = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    const filtered = dateFiltered.filter(
      (entry) => !trimmed || entry.row.title.toLowerCase().includes(trimmed),
    )
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sortKey)
      const vb = sortValue(b, sortKey)
      if (va < vb) return -sortDir
      if (va > vb) return sortDir
      return 0
    })
  }, [dateFiltered, query, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 1 ? -1 : 1))
    } else {
      setSortKey(key)
      setSortDir(key === 'title' ? 1 : -1)
    }
  }

  const headerProps = { sortKey, sortDir, onToggle: toggleSort }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-foreground text-2xl font-semibold">JD Analytics</h1>
        <p className="text-muted-foreground text-sm">
          High-level candidate progress across every JD — no need to open each
          dashboard.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
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
        <div className="relative max-w-xs flex-1 basis-56">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search JDs..."
            className="h-9 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {/* Aggregate summary for the SELECTED DATE FILTER, across every JD it
          matches — independent of the name search, which narrows only the
          table below. Same tile styling as the Analytics dialog's stats. */}
      {!isLoading && !isError && (
        <div
          className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5"
          aria-label={`Summary for ${dateFilter}`}
        >
          {(
            [
              ['JDs', String(summary.totalJds)],
              [
                'Pending',
                summary.pending === null ? '—' : String(summary.pending),
              ],
              ['Screen Select - HireSense', String(summary.ssHs)],
              ['Screen Reject - HireSense', String(summary.srHs)],
              ['Ratio', formatJdRatio(summary.ratio)],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="border-border bg-muted/30 rounded-lg border px-3 py-2"
            >
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="text-foreground text-xl font-semibold tabular-nums">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load JD analytics"
          description={getErrorMessage(
            error,
            'Please check your connection and try again.',
          )}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={ChartColumn}
          title="No JDs yet"
          description="Analytics will appear here once dashboards exist."
        />
      )}

      {!isLoading && !isError && rows.length > 0 && visible.length === 0 && (
        <EmptyState
          icon={ChartColumn}
          title="No matches found"
          description={
            query.trim()
              ? `Nothing matches "${query.trim()}".`
              : `No JDs created ${dateFilter === 'Today' ? 'today' : 'this week'}.`
          }
        />
      )}

      {!isLoading && !isError && visible.length > 0 && (
        <div className="border-border bg-card shadow-soft overflow-hidden rounded-2xl border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-border bg-muted/50 border-b text-xs">
                  <SortableHeader
                    label="JD Name"
                    sort="title"
                    {...headerProps}
                  />
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Created By
                  </th>
                  <SortableHeader
                    label="Created Date"
                    sort="createdAt"
                    {...headerProps}
                  />
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Completed Date
                  </th>
                  <SortableHeader
                    label="Pending"
                    sort="pending"
                    align="right"
                    {...headerProps}
                  />
                  <SortableHeader
                    label="SS.HS"
                    sort="ssHs"
                    align="right"
                    {...headerProps}
                  />
                  <SortableHeader
                    label="SR.HS"
                    sort="srHs"
                    align="right"
                    {...headerProps}
                  />
                  <SortableHeader
                    label="Ratio"
                    sort="ratio"
                    align="right"
                    {...headerProps}
                  />
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {visible.map(({ row, metrics }) => (
                  <tr
                    key={row.id}
                    className="hover:bg-muted/40 transition-colors duration-150"
                  >
                    <td className="max-w-72 truncate px-2 py-3 pl-4 font-medium">
                      {row.title}
                    </td>
                    <td className="text-muted-foreground max-w-48 truncate px-2 py-3">
                      {row.createdBy?.name || row.createdBy?.email || '—'}
                    </td>
                    <td className="text-muted-foreground px-2 py-3 whitespace-nowrap">
                      {formatDate(row.createdAt)}
                    </td>
                    <td className="text-muted-foreground px-2 py-3 whitespace-nowrap">
                      {row.completedAt ? formatDate(row.completedAt) : '—'}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {metrics.pending ?? '—'}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {metrics.ssHs}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {metrics.srHs}
                    </td>
                    <td className="px-2 py-3 pr-4 text-right font-medium tabular-nums">
                      {formatJdRatio(metrics.ratio)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
