-- Adobe Longlist — add "Screen Select" / "Screen Reject" candidate actions.
--
-- Additive only. Reuses the existing dashboard_status.action column and its
-- existing CHECK constraint (widened to include the two new values) — no
-- new columns, no new tables. The HR comment reuses the existing, already-
-- nullable `remarks` column (added in the very first schema migration,
-- already length-capped at 2000 chars by dashboard_status_remarks_length)
-- rather than a new one — see src/services/dashboardStatus.service.ts's
-- upsertCandidateAction, which now optionally includes it.
--
-- Backward compatible: every existing action value remains valid, no row is
-- rewritten, no existing constraint is tightened. A NOT NULL requirement
-- for Screen Reject's comment is deliberately NOT enforced here — remarks
-- stays nullable for every action, exactly as before; the "required for
-- Screen Reject" rule is UI-level validation only (see actionConfig.ts's
-- commentRequirement), consistent with there being no other per-value
-- validation rule anywhere in this schema today.

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
      'Screen Select',
      'Screen Reject'
    )
  );
