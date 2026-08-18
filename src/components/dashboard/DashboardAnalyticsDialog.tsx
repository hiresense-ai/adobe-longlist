import { useMemo } from 'react'
import { useTheme } from 'next-themes'
import { Loader2, User, Users2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getActionConfig } from '@/config/actionConfig'
import { useDashboardAnalytics } from '@/hooks/useDashboardAnalytics'
import { getErrorMessage } from '@/lib/errors'
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dashboard Analytics</DialogTitle>
          <DialogDescription>{`Read-only statistics for "${dashboard.title}".`}</DialogDescription>
        </DialogHeader>

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
  label: string
  count: number
  background: string
}

function ActionBreakdown({
  entries,
  pending,
}: {
  entries: DashboardActionBreakdownEntry[]
  pending: number | null
}) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const rows: BreakdownRow[] = useMemo(() => {
    const fromActions = entries.map((entry) => {
      const config = getActionConfig(entry.value as CandidateAction)
      const palette = config ? (isDark ? config.dark : config.light) : null
      return {
        key: entry.value,
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
        key: '__no_action__',
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
      <h3 className="text-foreground mb-2 text-sm font-medium">
        Candidate Actions
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No candidate actions recorded yet.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <span className="text-foreground w-36 shrink-0 truncate text-xs">
                {row.label}
              </span>
              <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(row.count / maxCount) * 100}%`,
                    backgroundColor: row.background,
                  }}
                />
              </div>
              <span className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">
                {row.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
