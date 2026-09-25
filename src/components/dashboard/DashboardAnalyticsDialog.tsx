import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from 'next-themes'
import { History, Loader2, User, Users2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ACTION_SORT_PARAM,
  NO_ACTION_SORT_VALUE,
  getActionConfig,
} from '@/config/actionConfig'
import { useAuth } from '@/hooks/useAuth'
import { useDashboardAnalytics } from '@/hooks/useDashboardAnalytics'
import { getErrorMessage } from '@/lib/errors'
import { canViewActionLogs } from '@/lib/permissions'
import { ROUTES } from '@/constants'
import type { CandidateAction } from '@/types'
import type {
  DashboardActionBreakdownEntry,
  DashboardAssignedUser,
  DashboardAssignedUsers,
} from '@/services/dashboardAnalytics.service'
import type { DashboardWithThumbnail } from '@/services/dashboards.service'

// Bar fill colors, not badge colors: actionConfig's own `background` fields
// are pastel (right for a badge's fill behind readable text, wrong for a
// 2px-tall bar which needs a saturated color to read at a glance) — the
// bar uses each action's `text` color instead, with these as the "No
// Action"/pending bar's equivalent saturated neutral.
const NEUTRAL_BAR_LIGHT = '#9CA3AF'
const NEUTRAL_BAR_DARK = '#6B7280'

/**
 * Read-only statistics for one dashboard: assigned-user roster counts,
 * candidate totals, and an action breakdown. Every number comes from the
 * dashboard-analytics Edge Function, which enforces the same Super
 * Admin/Admin/Viewer access rules server-side — this component never
 * decides who's allowed to see what, only whether to render the entry
 * point (see canViewDashboardAnalytics).
 *
 * Strictly read-only: no mutation, no write call, anywhere in this file.
 * Clicking a "Candidate Actions" row only navigates — it opens this
 * dashboard with that action's candidates shown first (view state; see
 * ACTION_SORT_PARAM), changing no data.
 */
export function DashboardAnalyticsDialog({
  dashboard,
  open,
  onOpenChange,
}: {
  dashboard: Pick<DashboardWithThumbnail, 'id' | 'title'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isLoading, isError, error } = useDashboardAnalytics(
    dashboard.id,
    open,
  )
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const showActionHistoryLink = Boolean(user && canViewActionLogs(user.role))

  // Opens this exact dashboard (by id) with the clicked action's candidates
  // first. Already on that dashboard (the dialog was opened from its own
  // Analytics button)? `replace` just updates the URL — the viewer stays
  // mounted and re-sorts its live iframe, no reload or second instance.
  function openSortedByAction(action: CandidateAction | null) {
    onOpenChange(false)
    const path = ROUTES.dashboard(dashboard.id)
    const search = new URLSearchParams({
      [ACTION_SORT_PARAM]: action ?? NO_ACTION_SORT_VALUE,
    })
    navigate(`${path}?${search.toString()}`, {
      replace: location.pathname === path,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dashboard Analytics</DialogTitle>
          <DialogDescription>{`Read-only statistics for "${dashboard.title}".`}</DialogDescription>
        </DialogHeader>

        {showActionHistoryLink && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              onOpenChange(false)
              navigate(`${ROUTES.actionLogs}?dashboardId=${dashboard.id}`)
            }}
          >
            <History className="size-4" />
            View Action History
          </Button>
        )}

        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        )}

        {isError && (
          <p className="text-destructive text-sm">
            {getErrorMessage(
              error,
              "Couldn't load analytics for this dashboard.",
            )}
          </p>
        )}

        {!isLoading && !isError && data && (
          <div className="space-y-6">
            <AssignedUsersSummary assignedUsers={data.assignedUsers} />
            <CandidateSummary
              total={data.candidates.total}
              actioned={data.candidates.actioned}
              pending={data.candidates.pending}
            />
            <ActionBreakdown
              entries={data.actionBreakdown}
              pending={data.candidates.pending}
              onSelect={openSortedByAction}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-border bg-muted/30 rounded-lg border px-3 py-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground text-xl font-semibold">{value}</p>
    </div>
  )
}

/** 👤 name (or email, if no name is set) + email underneath — only when a
 * name exists, so the identifier is never shown twice. */
function UserRow({ user }: { user: DashboardAssignedUser }) {
  const primary = user.name || user.email
  return (
    <div className="flex items-start gap-2 py-1">
      <User className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-foreground truncate text-sm">{primary}</p>
        {user.name && (
          <p className="text-muted-foreground truncate text-xs">{user.email}</p>
        )}
      </div>
    </div>
  )
}

/** Flat roster, no role sub-headings and no counts — just "Assigned Users"
 * followed by every person who can see this dashboard, in order: the
 * viewing Super Admin (if any) first, then assigned Admins, then assigned
 * Viewers, preserving the existing assignment order within each group. */
function AssignedUsersSummary({
  assignedUsers,
}: {
  assignedUsers: DashboardAssignedUsers
}) {
  const { superAdmin, admins, viewers } = assignedUsers
  const users = [...(superAdmin ? [superAdmin] : []), ...admins, ...viewers]

  return (
    <section>
      <h3 className="text-foreground mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Users2 className="size-4" />
        Assigned Users
      </h3>
      {users.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nobody is assigned to this dashboard yet.
        </p>
      ) : (
        <div className="space-y-1">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </div>
      )}
    </section>
  )
}

function CandidateSummary({
  total,
  actioned,
  pending,
}: {
  total: number | null
  actioned: number
  pending: number | null
}) {
  return (
    <section>
      <h3 className="text-foreground mb-2 text-sm font-medium">
        Candidate Statistics
      </h3>
      {total === null ? (
        <p className="text-muted-foreground text-sm">
          Total candidate count is unavailable for this dashboard's format.
        </p>
      ) : total === 0 ? (
        <p className="text-muted-foreground text-sm">
          This dashboard has no candidates yet.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="Total Candidates" value={total} />
          <StatTile label="Actioned" value={actioned} />
          <StatTile label="Pending" value={pending ?? '—'} />
        </div>
      )}
    </section>
  )
}

interface BreakdownRow {
  key: string
  /** What a click sorts to the top: the action value, or null for "No Action". */
  action: CandidateAction | null
  label: string
  count: number
  background: string
}

function ActionBreakdown({
  entries,
  pending,
  onSelect,
}: {
  entries: DashboardActionBreakdownEntry[]
  pending: number | null
  onSelect: (action: CandidateAction | null) => void
}) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const rows: BreakdownRow[] = useMemo(() => {
    const fromActions = entries.map((entry): BreakdownRow => {
      const config = getActionConfig(entry.value as CandidateAction)
      const palette = config ? (isDark ? config.dark : config.light) : null
      return {
        key: entry.value,
        action: entry.value as CandidateAction,
        label: config?.label ?? entry.value,
        count: entry.count,
        background: palette
          ? palette.text
          : isDark
            ? NEUTRAL_BAR_DARK
            : NEUTRAL_BAR_LIGHT,
      }
    })
    // "No Action" (pending) rendered alongside the real action values, same
    // as the product spec's own example table — omitted entirely when the
    // total candidate count (and therefore pending) couldn't be determined.
    if (pending !== null && pending > 0) {
      fromActions.push({
        key: NO_ACTION_SORT_VALUE,
        action: null,
        label: 'No Action',
        count: pending,
        background: isDark ? NEUTRAL_BAR_DARK : NEUTRAL_BAR_LIGHT,
      })
    }
    return fromActions.sort((a, b) => b.count - a.count)
  }, [entries, pending, isDark])

  const maxCount = Math.max(1, ...rows.map((row) => row.count))

  return (
    <section>
      <h3 className="text-foreground text-sm font-medium">Candidate Actions</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          No candidate actions recorded yet.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground mb-2 text-xs">
            Select an action to open the dashboard with those candidates first.
          </p>
          {/* Each row is a real button (Enter/Space, focus ring) over the
              same label/bar/count layout. The label wraps rather than
              truncating, so long action names stay fully readable. */}
          <div className="-mx-1.5 space-y-0.5">
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => onSelect(row.action)}
                aria-label={`${row.label}: ${row.count} — open the dashboard with these candidates first`}
                className="hover:bg-muted/70 focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 sm:py-1.5"
              >
                <span className="text-foreground w-36 shrink-0 text-xs leading-snug break-words sm:w-44">
                  {row.label}
                </span>
                <span className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                  <span
                    className="block h-full rounded-full transition-all"
                    style={{
                      width: `${(row.count / maxCount) * 100}%`,
                      backgroundColor: row.background,
                    }}
                  />
                </span>
                <span className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">
                  {row.count}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
