-- Adobe Longlist — JD Analytics "Completed Date": the moment a dashboard's
-- own Pending count (total candidates minus actioned) first reaches zero.
--
-- This is a DIFFERENT business event from a linked Requirement's own
-- completion ("Delivered Date", requirements.completed_at) and from when
-- the Requirement/dashboard was first raised ("Submitted Date"). All three
-- are tracked independently and must never be conflated:
--   Submitted Date  — requirements.created_at (or the dashboard's manual
--                     requirement_created_at / upload created_at fallback)
--   Delivered Date  — requirements.completed_at, while status = 'Completed'
--   Completed Date  — dashboards.pending_zero_at (this column)
--
-- Candidates and their actioned state live entirely outside Postgres — the
-- full candidate list only exists in the dashboard's own uploaded HTML in
-- Storage, and dashboard_status only ever gets a row once a candidate is
-- first touched. So "Pending" can only be computed where both are already
-- read together: the dashboard-analytics Edge Function's overview action.
-- That is also the only place this column is ever written — see its
-- module comment for exactly how and why.
alter table public.dashboards
  add column if not exists pending_zero_at timestamptz;

comment on column public.dashboards.pending_zero_at is
  'The first moment this dashboard''s Pending count (total candidates minus actioned) was observed to be exactly zero. NULL whenever Pending is currently greater than zero (cleared automatically if more candidates are added after full completion) or has never reached zero. Written only by the dashboard-analytics Edge Function''s overview action, the sole place Pending is computed. This is JD Analytics'' "Completed Date" — distinct from requirements.completed_at ("Delivered Date").';
