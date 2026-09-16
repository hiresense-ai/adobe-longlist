import { invokeEdgeFunction } from '@/lib/edgeFunction'
import type { CandidateAction } from '@/types'

const FUNCTION_NAME = 'action-logs'

/**
 * One Action Logs row, already resolved server-side — dashboard title,
 * candidate name, and the changed-by user's name/email all come pre-joined
 * from the action-logs Edge Function's single query (see its own module
 * comment for why: avoiding N+1 lookups for a page that can show thousands
 * of rows). Any of the resolved fields can be null if the underlying
 * dashboard/candidate/profile has since been deleted — the FKs use ON
 * DELETE SET NULL/CASCADE per candidate_action_logs' own migration, so the
 * log row can outlive what it once pointed to; the UI renders "—" for
 * those rather than guessing or crashing.
 */
export interface ActionLogRow {
  id: string
  dashboardId: string
  dashboardTitle: string | null
  candidateId: string
  candidateName: string | null
  previousAction: CandidateAction | null
  newAction: CandidateAction | null
  changedBy: string | null
  changedByName: string | null
  changedByEmail: string | null
  changedAt: string
}

export interface ListActionLogsParams {
  /** Matches candidate name, dashboard/JD title, or the changed-by user's
   * name/email — resolved server-side, never a client-side scan. */
  search?: string
  dashboardId?: string
  changedBy?: string
  action?: CandidateAction
  /** Inclusive lower bound on changed_at (ISO timestamp). */
  dateFrom?: string
  /** Exclusive upper bound on changed_at (ISO timestamp) — an [dateFrom,
   * dateTo) window, matching the rest of the app's date-filter convention
   * (see JD Analytics' matchesDateFilter). */
  dateTo?: string
  page: number
  pageSize: number
  sortDir: 'asc' | 'desc'
}

export interface ListActionLogsResult {
  data: ActionLogRow[]
  page: number
  pageSize: number
  total: number
}

/**
 * Reads a page of candidate_action_logs through the action-logs Edge
 * Function — the ONLY way to read that table at all (it has no
 * client-reachable RLS SELECT policy). The function itself re-verifies the
 * caller is a Super Admin on every call and 403s anyone else; this
 * function trusts nothing about the caller, it just forwards filters.
 */
export async function listActionLogs(
  params: ListActionLogsParams,
): Promise<ListActionLogsResult> {
  return invokeEdgeFunction<ListActionLogsResult>(FUNCTION_NAME, {
    action: 'list',
    payload: params,
  })
}
