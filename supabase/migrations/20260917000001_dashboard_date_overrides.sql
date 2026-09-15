-- Adobe Longlist — Super-Admin-only manual overrides for JD Analytics'
-- three independent business dates (Submitted / Delivered / Completed).
--
-- Deliberately separate columns from the fields that normally DERIVE these
-- dates, never a destructive edit of them:
--   Submitted Date — normally requirements.created_at (or
--                    dashboards.requirement_created_at / dashboards.
--                    created_at as fallbacks)
--   Delivered Date — normally requirements.completed_at
--   Completed Date — normally dashboards.pending_zero_at, auto-tracked by
--                    the dashboard-analytics Edge Function
-- Writing directly into requirements.created_at/completed_at from JD
-- Analytics would silently corrupt the Requirements tab's own Submitted/
-- Delivered Date for the SAME requirement (shared field), and fighting
-- pending_zero_at's own auto-stamp/clear logic would make a manual
-- correction disappear the next time Pending is read. A dedicated
-- override column avoids both: NULL (every existing row) changes nothing,
-- and each date's resolution order in dashboard-analytics simply checks
-- its override FIRST, before falling back to the existing derivation.
--
-- Edit access is enforced server-side in the dashboard-edit Edge Function,
-- mirroring how it already gates `thumbnail`: Super Admin only, Admin
-- requests including any of these keys are rejected outright. Viewing
-- (JD Analytics itself) remains Admin + Super Admin, unchanged.
alter table public.dashboards
  add column if not exists submitted_date_override timestamptz,
  add column if not exists delivered_date_override timestamptz,
  add column if not exists completed_date_override timestamptz;

comment on column public.dashboards.submitted_date_override is
  'Super-Admin-set manual override for JD Analytics'' Submitted Date. Takes precedence over the canonical linked requirement''s created_at and every other Submitted Date fallback. NULL (default) means no override -- unaffected.';
comment on column public.dashboards.delivered_date_override is
  'Super-Admin-set manual override for JD Analytics'' Delivered Date. Takes precedence over the canonical linked requirement''s completed_at. NULL (default) means no override -- unaffected.';
comment on column public.dashboards.completed_date_override is
  'Super-Admin-set manual override for JD Analytics'' Completed Date. Takes precedence over the auto-tracked pending_zero_at. NULL (default) means no override -- unaffected.';
