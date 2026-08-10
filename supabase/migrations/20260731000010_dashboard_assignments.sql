-- Adobe Longlist — dashboard assignments.
--
-- Introduces per-dashboard access lists so visibility (and, for Admin, who
-- they may manage) is assignment-based rather than "every authenticated
-- role sees every dashboard" (the model dashboards_select has had since
-- day one — `using (true)`, unchanged until this migration).
--
-- Role hierarchy for this feature:
--   super_admin — sees and can modify every dashboard and every
--                 assignment, unconditionally. Never needs a row in this
--                 table themselves; is_super_admin() is checked directly.
--   admin       — sees only dashboards they have a row in. May add or
--                 remove VIEWER assignments on those dashboards only, and
--                 may never touch their own assignment row (that would be
--                 "remove their own access", explicitly disallowed) or any
--                 admin/super_admin assignment.
--   viewer      — sees only dashboards they have a row in. No assignment
--                 permissions at all — read-only, as everywhere else.
--
-- All of this table's actual authorization logic (who may add/remove whom)
-- lives in the dashboard-assignments Edge Function, the same pattern
-- admin-users already uses for profiles: the rules here (whether a caller
-- is even assigned to the dashboard in question, whether a target is a
-- viewer, self-removal) are exactly the kind of multi-step, cross-table
-- checks that don't reduce to a single RLS boolean cleanly, and centralizing
-- them in one reviewable place is the same reasoning admin-users was built
-- on. RLS below is the SELECT policy (needed for the dashboards_select
-- subquery and for a user to read their own assignment rows) plus a
-- deliberate ABSENCE of any insert/update/delete policy for authenticated/
-- anon — exactly like audit_logs, the only way a row is written is through
-- the Edge Function's service-role client.

create table if not exists public.dashboard_assignments (
  id           uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.dashboards (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  assigned_at  timestamptz not null default now(),
  -- Who granted this assignment. Null for rows created by the one-time
  -- backfill below (nobody "decided" those — they're a snapshot of who
  -- already had access the moment this feature was introduced) and for any
  -- assignment whose granting admin/super_admin has since been deleted.
  assigned_by  uuid references public.profiles (id) on delete set null,
  unique (dashboard_id, user_id)
);

comment on table public.dashboard_assignments is 'Per-dashboard access list. A row means that user can see (and, if super_admin, modify) that dashboard. Written only by the dashboard-assignments Edge Function (service role) — see its module comment for the authorization rules.';

create index if not exists dashboard_assignments_dashboard_idx
  on public.dashboard_assignments (dashboard_id);
create index if not exists dashboard_assignments_user_idx
  on public.dashboard_assignments (user_id);

alter table public.dashboard_assignments enable row level security;

-- Read your own assignment rows, or (Super Admin) every row. This is
-- intentionally NOT "see every assignment on a dashboard you're assigned
-- to" — that broader roster view is only exposed through the Edge
-- Function's `list` action, which does its own authorization (including
-- the Admin-must-be-assigned-themselves check) before returning it. A
-- direct PostgREST query against this table — bypassing that logic
-- entirely — must not be able to enumerate who else has access.
drop policy if exists "dashboard_assignments_select" on public.dashboard_assignments;
create policy "dashboard_assignments_select"
  on public.dashboard_assignments for select
  to authenticated
  using (user_id = auth.uid() or public.is_super_admin());

-- No insert/update/delete policy for authenticated/anon at all — see the
-- module comment above. Writes only ever happen via the service-role
-- client inside the dashboard-assignments Edge Function.

-- ---------------------------------------------------------------------------
-- Backfill: every dashboard that exists right now x every current admin/
-- viewer profile. Without this, flipping dashboards_select to
-- assignment-based below would immediately make every existing dashboard
-- invisible to every existing Admin and Viewer — the opposite of "no
-- existing RBAC functionality should change". assigned_by is left null
-- (see the column comment): this is a migration snapshot, not a real grant
-- by anyone.
-- ---------------------------------------------------------------------------
insert into public.dashboard_assignments (dashboard_id, user_id, assigned_by)
select d.id, p.id, null
from public.dashboards d
cross join public.profiles p
where p.role in ('admin', 'viewer')
on conflict (dashboard_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- dashboards_select: from "every authenticated role" to assignment-based.
-- Super Admin keeps unconditional full visibility (matches "Super Admin has
-- full control" / "Modify every dashboard" for the write side, and there
-- would be no way for a Super Admin to discover an unassigned dashboard —
-- including one they haven't gotten around to assigning yet — if their own
-- read access depended on being assigned too).
-- ---------------------------------------------------------------------------
drop policy if exists "dashboards_select" on public.dashboards;
create policy "dashboards_select"
  on public.dashboards for select
  to authenticated
  using (
    public.is_super_admin()
    or exists (
      select 1
      from public.dashboard_assignments da
      where da.dashboard_id = dashboards.id
        and da.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket read: same assignment check, matched by BOTH the
-- dashboard's HTML file (storage_path) and its thumbnail (thumbnail) —
-- both live in the same `dashboards` bucket (see src/constants/index.ts:
-- STORAGE_FOLDER = 'dashboards', THUMBNAIL_STORAGE_FOLDER =
-- 'dashboards/thumbnails'). Without covering both, an assigned user's
-- thumbnail would silently fail to load even though the dashboard row and
-- HTML file were correctly visible.
-- ---------------------------------------------------------------------------
drop policy if exists "dashboards_bucket_select" on storage.objects;
create policy "dashboards_bucket_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'dashboards'
    and (
      public.is_super_admin()
      or exists (
        select 1
        from public.dashboards d
        join public.dashboard_assignments da on da.dashboard_id = d.id
        where da.user_id = auth.uid()
          and (d.storage_path = storage.objects.name or d.thumbnail = storage.objects.name)
      )
    )
  );
