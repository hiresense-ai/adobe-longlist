-- Adobe Longlist — link a requirement to its JD dashboard.
--
-- Product decision (2026-09-04): JD Analytics rows are dashboards, but a
-- Completed Date belongs to the requirement lifecycle — so the two need an
-- explicit relationship. This is the smallest safe shape: one nullable FK
-- on requirements, set ONLY through the requirements Edge Function (deny-
-- all RLS on this table means there is no other write path), and only by
-- a Super Admin (the role that owns the requirement lifecycle). Never
-- inferred: no title matching, no backfill — unlinked requirements simply
-- contribute nothing, and JD Analytics keeps showing "—" for dashboards
-- with no linked Completed requirement.
--
-- on delete set null: removing a dashboard must never delete or corrupt a
-- requirement — the link just disappears.

alter table public.requirements
  add column if not exists dashboard_id uuid
    references public.dashboards (id) on delete set null;

create index if not exists requirements_dashboard_idx
  on public.requirements (dashboard_id)
  where dashboard_id is not null;

comment on column public.requirements.dashboard_id is
  'The JD dashboard this requirement belongs to — set by a Super Admin via the requirements Edge Function; used by JD Analytics to surface the requirement''s completion date on the dashboard''s row. Null = not linked.';
