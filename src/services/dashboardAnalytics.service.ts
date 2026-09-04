import { invokeEdgeFunction } from '@/lib/edgeFunction'
import { ACTION_CONFIG } from '@/config/actionConfig'
import type { CandidateAction } from '@/types'

const FUNCTION_NAME = 'dashboard-analytics'

/** Minimal identity for the Assigned Users list — name (falls back to email
 * when unset) and email only. */
export interface DashboardAssignedUser {
  id: string
  name: string | null
  email: string
}

export interface DashboardAssignedUsers {
  total: number
  /** The viewing Super Admin's own identity — sourced from their session,
   * never from a dashboard_assignments row. Null when the caller is an
   * Admin or Viewer: only a Super Admin ever sees the Super Admin here. */
  superAdmin: DashboardAssignedUser | null
  admins: DashboardAssignedUser[]
  viewers: DashboardAssignedUser[]
}

export interface DashboardCandidateCounts {
  /** Null when the dashboard's candidate data couldn't be parsed from its
   * stored HTML (unrecognized generator shape) — never a guess. */
  total: number | null
  actioned: number
  /** Null whenever `total` is null, for the same reason. */
  pending: number | null
}

/** One bucket in the action breakdown — `value` is always the raw stored
 * dashboard_status.action string, never a hardcoded label, so any current
 * or future valid action value shows up automatically. */
export interface DashboardActionBreakdownEntry {
  value: string
  count: number
}

export interface DashboardAnalytics {
  dashboard: { id: string; title: string }
  assignedUsers: DashboardAssignedUsers
  candidates: DashboardCandidateCounts
  actionBreakdown: DashboardActionBreakdownEntry[]
}

export async function getDashboardAnalytics(
  dashboardId: string,
): Promise<DashboardAnalytics> {
  return invokeEdgeFunction<DashboardAnalytics>(FUNCTION_NAME, {
    action: 'get',
    payload: { dashboardId },
  })
}

// ---------------------------------------------------------------------------
// JD Analytics — the high-level all-dashboards overview. One request, one
// aggregated response (the Edge Function's `overview` action), computed
// from the exact same sources as the per-dashboard analytics above, so the
// two views can never disagree.
// ---------------------------------------------------------------------------

export interface JdAnalyticsRow {
  id: string
  title: string
  createdBy: DashboardAssignedUser | null
  createdAt: string
  /** Always null today: dashboards carry no completion concept anywhere in
   * the schema (and the separate Requirements lifecycle stores no
   * completion timestamp and has no link to a dashboard), so a real
   * completed date cannot be derived — the UI shows "—". In the contract
   * now so a future `dashboards.completed_at` needs no shape change. */
  completedAt: string | null
  candidates: DashboardCandidateCounts
  actionBreakdown: DashboardActionBreakdownEntry[]
}

export async function getJdAnalyticsOverview(): Promise<{
  rows: JdAnalyticsRow[]
}> {
  return invokeEdgeFunction<{ rows: JdAnalyticsRow[] }>(FUNCTION_NAME, {
    action: 'overview',
  })
}

/**
 * SS.HS qualifying actions — an EXPLICIT allowlist (per product spec, never
 * "everything that isn't a reject"), built from the canonical
 * ACTION_CONFIG values so there is exactly one source of truth for action
 * strings. "Reviewed earlier (Adobe)" in the spec covers both stored
 * variants, (SR) and (TR). A candidate has ONE current action in
 * dashboard_status (state, not history), so each candidate can contribute
 * at most +1 by construction.
 */
export const SS_HS_ACTIONS: ReadonlySet<CandidateAction> = new Set([
  ACTION_CONFIG['Screen Select - HireSense'].value,
  ACTION_CONFIG['Interview Reject - Adobe'].value,
  ACTION_CONFIG['Reviewed earlier (SR) - Adobe'].value,
  ACTION_CONFIG['Reviewed earlier (TR) - Adobe'].value,
  ACTION_CONFIG['Interview stage - Adobe'].value,
  ACTION_CONFIG['Interview stage - HireSense'].value,
  ACTION_CONFIG['Offer - Adobe'].value,
  ACTION_CONFIG['Offer - HireSense'].value,
])

export const SR_HS_ACTION: CandidateAction =
  ACTION_CONFIG['Screen Reject - HireSense'].value

export interface JdMetrics {
  /** Candidates with no action yet (total − actioned) — null when the
   * dashboard's candidate total couldn't be read from its stored HTML. */
  pending: number | null
  ssHs: number
  srHs: number
  /** SR.HS conversion from SS.HS: srHs ÷ ssHs × 100. Null when ssHs is 0
   * — the ratio is undefined there (0% would wrongly read as "no rejects"
   * even when rejects exist), so it renders as "—" per the feature's
   * established convention. Never Infinity/NaN. */
  ratio: number | null
}

/** Exact-value classification of one dashboard's action breakdown into the
 * JD Analytics buckets. Unlisted values are counted in neither bucket. */
export function computeJdMetrics(row: JdAnalyticsRow): JdMetrics {
  let ssHs = 0
  let srHs = 0
  for (const entry of row.actionBreakdown) {
    if (entry.value === SR_HS_ACTION) srHs += entry.count
    else if (SS_HS_ACTIONS.has(entry.value as CandidateAction)) {
      ssHs += entry.count
    }
  }
  return {
    pending: row.candidates.pending,
    ssHs,
    srHs,
    ratio: ssHs === 0 ? null : (srHs / ssHs) * 100,
  }
}

export interface JdMetricsSummary {
  /** How many JDs/dashboards the aggregate covers. */
  totalJds: number
  /** Sum of the per-dashboard pending counts. Dashboards whose candidate
   * total was unreadable (pending null) contribute nothing; the value is
   * null only when EVERY covered dashboard is unreadable, mirroring the
   * per-row "—" convention rather than showing a fabricated 0. */
  pending: number | null
  ssHs: number
  srHs: number
  /** The Ratio definition applied to the AGGREGATE counts — total srHs ÷
   * total ssHs × 100, null when total ssHs is 0 (never NaN/Infinity).
   * Deliberately NOT an average of per-dashboard ratios: counts are summed
   * FIRST, then the one formula runs on the totals. */
  ratio: number | null
}

/** Aggregates already-computed per-dashboard metrics into one summary.
 * Pure summation over the same computeJdMetrics values the table rows
 * render — by construction the summary can never disagree with the rows
 * it covers. */
export function aggregateJdMetrics(metrics: JdMetrics[]): JdMetricsSummary {
  let ssHs = 0
  let srHs = 0
  let pendingSum = 0
  let pendingKnown = 0
  for (const m of metrics) {
    ssHs += m.ssHs
    srHs += m.srHs
    if (m.pending !== null) {
      pendingSum += m.pending
      pendingKnown++
    }
  }
  return {
    totalJds: metrics.length,
    pending: metrics.length > 0 && pendingKnown === 0 ? null : pendingSum,
    ssHs,
    srHs,
    ratio: ssHs === 0 ? null : (srHs / ssHs) * 100,
  }
}

/** THE one place a JD Analytics ratio becomes display text, so rows and
 * the aggregate tiles can never format differently: up to two decimals,
 * trailing zeros trimmed (21.67%, 10.4%, 25%), "—" for the undefined
 * (ssHs = 0) case. */
export function formatJdRatio(ratio: number | null): string {
  if (ratio === null) return '—'
  return `${Number(ratio.toFixed(2))}%`
}
