-- Adobe Longlist — add the "Candidate Yet to Revert" candidate action.
--
-- Additive only: every existing action value stays valid and no row is
-- rewritten. Three CHECK constraints enumerate the allowed action strings
-- and all three must widen together, or the new value would be rejected
-- somewhere along the write path:
--
--   dashboard_status.action                 — the live per-candidate value
--   candidate_action_logs.previous_action   — audit trail, the "from" side
--   candidate_action_logs.new_action        — audit trail, the "to" side
--
-- The audit trigger (log_candidate_action_change) copies OLD/NEW action
-- verbatim, so a change TO or FROM the new value is logged with no trigger
-- change; without the two log constraints widened here, that insert would
-- fail and roll back the candidate's action update along with it.

alter table public.dashboard_status
  drop constraint if exists dashboard_status_action_check;

alter table public.dashboard_status
  add constraint dashboard_status_action_check check (
    action is null or action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense',
      'Candidate Yet to Revert'
    )
  );

alter table public.candidate_action_logs
  drop constraint if exists candidate_action_logs_previous_action_check;

alter table public.candidate_action_logs
  add constraint candidate_action_logs_previous_action_check check (
    previous_action is null or previous_action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense',
      'Candidate Yet to Revert'
    )
  );

alter table public.candidate_action_logs
  drop constraint if exists candidate_action_logs_new_action_check;

alter table public.candidate_action_logs
  add constraint candidate_action_logs_new_action_check check (
    new_action is null or new_action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense',
      'Candidate Yet to Revert'
    )
  );
