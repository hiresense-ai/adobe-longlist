-- Adobe Longlist — candidate Action tracking.
-- Additive only: reuses the existing dashboard_status table (and therefore
-- its existing RLS policies and Realtime publication) rather than
-- introducing a parallel table/channel, so "Action" changes sync through
-- the exact same postgres_changes subscription the app already has.
--
-- Action is completely independent of the existing `status` column (the
-- recruiting-pipeline stage shown by some dashboards' own <select>) and of
-- whatever "Status" text (e.g. Active/Passive availability) an uploaded
-- dashboard's own table happens to display — this never touches either.

alter table public.dashboard_status
  add column if not exists action text;

alter table public.dashboard_status
  add constraint dashboard_status_action_check check (
    action is null or action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense'
    )
  );

comment on column public.dashboard_status.action is 'Recruiter-selected next action for this candidate on this dashboard. Independent of `status`. Values enforced by dashboard_status_action_check and centralized in src/config/actionConfig.ts.';
