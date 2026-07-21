import { supabase } from '@/supabase/client'
import type { CandidateAction, CandidateStatus, DashboardStatus } from '@/types'

export interface UpsertCandidateStatusInput {
  dashboardId: string
  candidateName: string
  candidateEmail?: string
  status: CandidateStatus
  remarks?: string
}

export interface UpsertCandidateActionInput {
  dashboardId: string
  candidateName: string
  action: CandidateAction | null
}

export async function listStatusesForDashboard(
  dashboardId: string,
): Promise<DashboardStatus[]> {
  const { data, error } = await supabase
    .from('dashboard_status')
    .select('*')
    .eq('dashboard_id', dashboardId)

  if (error) throw error
  return data
}

export async function upsertCandidateStatus(
  input: UpsertCandidateStatusInput,
): Promise<DashboardStatus> {
  const { data, error } = await supabase
    .from('dashboard_status')
    .upsert(
      {
        dashboard_id: input.dashboardId,
        candidate_name: input.candidateName,
        candidate_email: input.candidateEmail ?? null,
        status: input.status,
        remarks: input.remarks ?? null,
      },
      { onConflict: 'dashboard_id,candidate_name' },
    )
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Upserts only the `action` column — leaves `status`/`remarks` untouched on
 * an existing row, and lets them take their normal defaults on a fresh one.
 * Action tracking works even for dashboards with no `status` select at all.
 */
export async function upsertCandidateAction(
  input: UpsertCandidateActionInput,
): Promise<DashboardStatus> {
  const { data, error } = await supabase
    .from('dashboard_status')
    .upsert(
      {
        dashboard_id: input.dashboardId,
        candidate_name: input.candidateName,
        action: input.action,
      },
      { onConflict: 'dashboard_id,candidate_name' },
    )
    .select()
    .single()

  if (error) throw error
  return data
}
