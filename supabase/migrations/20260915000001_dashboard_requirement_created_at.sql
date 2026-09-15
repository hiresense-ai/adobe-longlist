-- Adobe Longlist — external/manual Requirement Created Date for a dashboard.
--
-- Some dashboards are uploaded before any tracked Requirement exists for
-- them (the requirement was received externally — email, a phone call —
-- and never entered through Requirements). For those, a Super Admin can
-- record when the requirement was actually raised at upload time, so JD
-- Analytics's "Created Date" reflects that real date instead of the
-- dashboard's own upload timestamp.
--
-- Deliberately NOT a new "linked/unlinked" boolean column: NULL already
-- means exactly "no override — behave as today," which is what every
-- existing dashboard has, so this migration changes nothing about current
-- behavior. Populated means "use this as the Requirement Created Date
-- fallback." The real, authoritative link remains requirements.dashboard_id
-- (see 20260904000004_requirement_dashboard_link.sql) — once a dashboard
-- has an actual linked requirement, that requirement's own created_at
-- always wins over this column, unchanged from the existing precedence in
-- the dashboard-analytics Edge Function.
alter table public.dashboards
  add column if not exists requirement_created_at timestamptz;

comment on column public.dashboards.requirement_created_at is
  'Optional manual/external Requirement Created Date, set at upload time when no tracked Requirement exists yet for this dashboard. Used by JD Analytics as a fallback for Created Date only while no requirement is linked via requirements.dashboard_id.';
