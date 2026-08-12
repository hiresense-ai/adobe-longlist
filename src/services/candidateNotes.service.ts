import { supabase } from '@/supabase/client'
import type { CandidateNote } from '@/types'

/**
 * Deliberately its own service, not folded into dashboardStatus.service.ts —
 * candidate_notes is an independent table from dashboard_status, and Notes
 * is an independent feature from the Screen Select/Reject HR comment (which
 * owns dashboard_status.remarks). See the candidate_notes migration for why.
 */

export async function listNotesForDashboard(
  dashboardId: string,
): Promise<CandidateNote[]> {
  const { data, error } = await supabase
    .from('candidate_notes')
    .select('*')
    .eq('dashboard_id', dashboardId)

  if (error) throw error
  return data
}

export interface UpsertCandidateNoteInput {
  dashboardId: string
  candidateName: string
  note: string
}

export async function upsertCandidateNote(
  input: UpsertCandidateNoteInput,
): Promise<CandidateNote> {
  const { data, error } = await supabase
    .from('candidate_notes')
    .upsert(
      {
        dashboard_id: input.dashboardId,
        candidate_name: input.candidateName,
        note: input.note || null,
      },
      { onConflict: 'dashboard_id,candidate_name' },
    )
    .select()
    .single()

  if (error) throw error
  return data
}
