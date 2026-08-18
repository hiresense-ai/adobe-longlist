import { invokeEdgeFunction } from '@/lib/edgeFunction'

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
   * Admin: Admins never see the Super Admin here at all. */
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
