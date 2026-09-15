import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Briefcase,
  ChartColumn,
  Check,
  Clock,
  Loader2,
  Pencil,
  Percent,
  RotateCcw,
  Search,
  UserCheck,
  UserX,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { DashboardAnalyticsDialog } from '@/components/dashboard/DashboardAnalyticsDialog'
import { useAuth } from '@/hooks/useAuth'
import { useJdAnalytics } from '@/hooks/useDashboardAnalytics'
import {
  aggregateJdMetrics,
  computeJdMetrics,
  formatJdRatio,
  type JdAnalyticsRow,
  type JdMetrics,
} from '@/services/dashboardAnalytics.service'
import {
  updateDashboardDateOverride,
  type DashboardDateOverrideField,
} from '@/services/dashboardAdmin.service'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/utils/date'

/** Which SUBMISSION window a row must fall in — Today/This Week answer "was
 * this JD's Requirement submitted in this period", based on Submitted Date
 * (submittedAt), never Delivered Date or Completed Date. "This Week" is the
 * CURRENT calendar week starting Monday 00:00 in the viewer's local
 * timezone — matching how the rest of the app treats dates as local
 * (formatDate). All Time ignores this entirely. In Progress is a SEPARATE,
 * independently-toggleable filter (Pending > 0) combinable with any of the
 * three — see inProgressOnly below — not a fourth mutually-exclusive
 * option in this same set. */
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

function matchesDateFilter(submittedAt: string, filter: DateFilter): boolean {
  if (filter === 'All Time') return true
  const submitted = new Date(submittedAt)
  const start = filter === 'Today' ? startOfToday() : startOfWeek()
  // An upper bound too, not just a lower one — Submitted Date can now be a
  // Super Admin's manual override, which (unlike every value it could
  // previously derive from) may legitimately be set in the future. Without
  // this, a future-dated override would match "Today"/"This Week" for
  // every day between now and that date, not just its own day/week.
  const end = new Date(start)
  end.setDate(end.getDate() + (filter === 'Today' ? 1 : 7))
  return submitted >= start && submitted < end
}

/** The empty-state message for every dateFilter × inProgressOnly
 * combination, since In Progress can combine with any of the three date
 * windows (Today + In Progress, This Week + In Progress, All Time + In
 * Progress). */
function describeEmptyFilter(filter: DateFilter, inProgressOnly: boolean) {
  const window =
    filter === 'Today'
      ? 'submitted today'
      : filter === 'This Week'
        ? 'submitted this week'
        : null
  if (window && inProgressOnly) return `No JDs ${window} are in progress.`
  if (window) return `No JDs ${window}.`
  if (inProgressOnly) return 'No JDs are in progress.'
  return 'No JDs match the current filters.'
}

type SortKey = 'title' | 'submittedAt' | 'pending' | 'ssHs' | 'srHs' | 'ratio'

interface RowWithMetrics {
  row: JdAnalyticsRow
  metrics: JdMetrics
}

function sortValue(entry: RowWithMetrics, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return entry.row.title.toLowerCase()
    case 'submittedAt':
      return new Date(entry.row.submittedAt).getTime()
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

/** ISO timestamp -> `<input type="date">` value, using LOCAL date parts
 * (never UTC) so a date picked as e.g. Sep 15 round-trips as Sep 15
 * regardless of timezone offset — same convention the Upload Dashboard
 * form's own date input already follows. */
function isoToDateInputValue(iso: string): string {
  const d = new Date(iso)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** `<input type="date">` value -> ISO timestamp at LOCAL midnight — the
 * exact inverse of isoToDateInputValue, and the same
 * `new Date(year, month - 1, day)` construction UploadDashboardDialog uses
 * for requirementCreatedAt, so both features store dates the same way. */
function dateInputValueToIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toISOString()
}

/**
 * One JD Analytics date cell (Submitted / Delivered / Completed). For
 * everyone but a Super Admin this just renders the resolved date, same as
 * before. A Super Admin additionally gets a pencil trigger that opens a
 * native calendar date input; saving writes straight to the dashboard's
 * manual override column via updateDashboardDateOverride (super_admin-only
 * server-side, enforced by dashboard-edit regardless of this UI), which
 * takes precedence over the normal derivation from then on. "Reset"
 * clears the override so the date goes back to being derived automatically
 * — always available in edit mode since this cell has no way to know
 * up front whether today's value came from an override or the normal
 * derivation.
 */
function EditableDateCell({
  dashboardId,
  field,
  value,
  editable,
  onSaved,
}: {
  dashboardId: string
  field: DashboardDateOverrideField
  value: string | null
  editable: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() =>
    value ? isoToDateInputValue(value) : '',
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  if (!editable) {
    return (
      <td className="text-muted-foreground px-2 py-3 whitespace-nowrap">
        {value ? formatDate(value) : '—'}
      </td>
    )
  }

  if (!editing) {
    return (
      <td className="text-muted-foreground px-2 py-3 whitespace-nowrap">
        <div className="group flex items-center gap-1">
          <span>{value ? formatDate(value) : '—'}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Edit date"
            aria-label={`Edit ${field}`}
            className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => {
              setDraft(value ? isoToDateInputValue(value) : '')
              setSaveError(null)
              setEditing(true)
            }}
          >
            <Pencil />
          </Button>
        </div>
      </td>
    )
  }

  async function save(newValue: string | null) {
    setSaving(true)
    setSaveError(null)
    try {
      await updateDashboardDateOverride(dashboardId, field, newValue)
      setEditing(false)
      onSaved()
    } catch (error) {
      // Stay in edit mode on failure (never silently drop the attempt) so
      // the Super Admin sees why and can retry without re-entering the
      // date.
      setSaveError(getErrorMessage(error, 'Could not save this date.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <td className="px-2 py-3 whitespace-nowrap">
      <div className="flex items-center gap-1">
        <Input
          type="date"
          autoFocus
          className="h-8 w-36"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        {saving ? (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Save"
              aria-label="Save date"
              disabled={!draft}
              onClick={() => void save(dateInputValueToIso(draft))}
            >
              <Check />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Reset to automatic"
              aria-label="Reset to automatic date"
              onClick={() => void save(null)}
            >
              <RotateCcw />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Cancel"
              aria-label="Cancel edit"
              onClick={() => {
                setSaveError(null)
                setEditing(false)
              }}
            >
              <X />
            </Button>
          </>
        )}
      </div>
      {saveError && (
        <p className="text-destructive mt-1 w-36 text-xs whitespace-normal">
          {saveError}
        </p>
      )}
    </td>
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
  const { user } = useAuth()
  // Submitted/Delivered/Completed Date are calendar-editable for Super
  // Admin only — Admin (and Viewer, already excluded from this whole page)
  // keeps read-only cells. Enforced again server-side in dashboard-edit
  // regardless of this check.
  const canEditDates = user?.role === 'super_admin'
  const { data, isLoading, isError, error, refetch } = useJdAnalytics()

  const [dateFilter, setDateFilter] = useState<DateFilter>('All Time')
  // Independent of dateFilter — combinable with any of Today / This Week /
  // All Time (item: "preserve/support Today + In Progress" etc.), not a
  // fourth mutually-exclusive option in that same button group.
  const [inProgressOnly, setInProgressOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('submittedAt')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)
  // Which JD's Dashboard Analytics dialog is open, if any. A row's `id` IS
  // the dashboard's real id (see the dashboard-analytics Edge Function's
  // `overview` action) — never a name lookup — so this is passed straight
  // into the EXISTING DashboardAnalyticsDialog/useDashboardAnalytics, the
  // same component and query the Dashboards page already uses. Its query
  // key is keyed by dashboard id, so switching JDs can never show stale
  // data from the previous one.
  const [analyticsDashboard, setAnalyticsDashboard] = useState<{
    id: string
    title: string
  } | null>(null)

  const rows = useMemo<RowWithMetrics[]>(
    () =>
      (data?.rows ?? []).map((row) => ({
        row,
        metrics: computeJdMetrics(row),
      })),
    [data],
  )

  // Date filter + In Progress together — the aggregate summary is computed
  // over THIS set (every JD matching both, exactly as the product rule
  // states), so the name search below narrows only the table, never the
  // totals. All rows are already in memory from the one batched overview
  // response, so the summary is pagination-proof by construction (there is
  // no pagination — the table always renders the full set). In Progress
  // means Pending > 0; a dashboard whose candidate total couldn't be read
  // (pending null) is excluded from In Progress — never assumed either way.
  const dateFiltered = useMemo(
    () =>
      rows.filter(
        (entry) =>
          matchesDateFilter(entry.row.submittedAt, dateFilter) &&
          (!inProgressOnly ||
            (entry.metrics.pending !== null && entry.metrics.pending > 0)),
      ),
    [rows, dateFilter, inProgressOnly],
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
        {/* A separate toggle, not part of the DATE_FILTERS group above —
            combines with any of the three (Today + In Progress, etc.), per
            the product rule. Pending > 0, independent of any date. ml-auto
            pins it flush to the row's right edge on wide viewports; it
            simply wraps below the rest on narrow ones. */}
        <Button
          type="button"
          size="sm"
          variant={inProgressOnly ? 'default' : 'outline'}
          aria-pressed={inProgressOnly}
          onClick={() => setInProgressOnly((prev) => !prev)}
          className="ml-auto"
        >
          In Progress
        </Button>
      </div>

      {/* Aggregate summary for the SELECTED DATE FILTER, across every JD it
          matches — independent of the name search, which narrows only the
          table below. Same tile styling as the Analytics dialog's stats. */}
      {!isLoading && !isError && (
        <div
          className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5"
          aria-label={`Summary for ${dateFilter}${inProgressOnly ? ' + In Progress' : ''}`}
        >
          {/* Display labels only — "Screen Select"/"Screen Reject" here are
              the same ssHs/srHs metrics computed from the canonical
              "Screen Select - HireSense"/"Screen Reject - HireSense" action
              values, which are unchanged everywhere else. Icons follow the
              existing section-heading pattern (lucide + size-3.5 + gap-1.5,
              same as the Analytics dialog's headings). */}
          {(
            [
              [Briefcase, 'JDs', String(summary.totalJds)],
              [
                Clock,
                'Pending',
                summary.pending === null ? '—' : String(summary.pending),
              ],
              [UserCheck, 'Screen Select', String(summary.ssHs)],
              [UserX, 'Screen Reject', String(summary.srHs)],
              [Percent, 'Ratio', formatJdRatio(summary.ratio)],
            ] as const
          ).map(([Icon, label, value]) => (
            <div
              key={label}
              className="border-border bg-muted/30 rounded-lg border px-3 py-2"
            >
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                {label}
              </p>
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
              : describeEmptyFilter(dateFilter, inProgressOnly)
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
                    label="Submitted Date"
                    sort="submittedAt"
                    {...headerProps}
                  />
                  <th className="text-muted-foreground px-2 py-3 font-medium">
                    Delivered Date
                  </th>
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
                    label="Screen Select"
                    sort="ssHs"
                    align="right"
                    {...headerProps}
                  />
                  <SortableHeader
                    label="Screen Reject"
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
                    <td className="max-w-72 px-2 py-3 pl-4 font-medium">
                      <div className="flex items-center gap-1">
                        <span className="truncate">{row.title}</span>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground shrink-0"
                          title="Dashboard Analytics"
                          aria-label={`Dashboard Analytics for ${row.title}`}
                          onClick={() =>
                            setAnalyticsDashboard({
                              id: row.id,
                              title: row.title,
                            })
                          }
                        >
                          <BarChart3 />
                        </Button>
                      </div>
                    </td>
                    <td className="text-muted-foreground max-w-48 truncate px-2 py-3">
                      {row.createdBy?.name || row.createdBy?.email || '—'}
                    </td>
                    <EditableDateCell
                      dashboardId={row.id}
                      field="submittedDateOverride"
                      value={row.submittedAt}
                      editable={canEditDates}
                      onSaved={() => void refetch()}
                    />
                    <EditableDateCell
                      dashboardId={row.id}
                      field="deliveredDateOverride"
                      value={row.deliveredAt}
                      editable={canEditDates}
                      onSaved={() => void refetch()}
                    />
                    <EditableDateCell
                      dashboardId={row.id}
                      field="completedDateOverride"
                      value={row.completedAt}
                      editable={canEditDates}
                      onSaved={() => void refetch()}
                    />
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

      {analyticsDashboard && (
        <DashboardAnalyticsDialog
          dashboard={analyticsDashboard}
          open={Boolean(analyticsDashboard)}
          onOpenChange={(open) => {
            if (!open) setAnalyticsDashboard(null)
          }}
        />
      )}
    </div>
  )
}
