-- Adobe Longlist — Row Level Security policies
-- Depends on 20260720000001_init_schema.sql (tables + is_admin() helper).

alter table public.profiles enable row level security;
alter table public.dashboards enable row level security;
alter table public.dashboard_status enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert/delete policy: rows are created by the on_auth_user_created
-- trigger (security definer) and are never inserted directly by clients.

-- ---------------------------------------------------------------------------
-- dashboards — every authenticated user can browse; only admins manage
-- ---------------------------------------------------------------------------
drop policy if exists "dashboards_select" on public.dashboards;
create policy "dashboards_select"
  on public.dashboards for select
  to authenticated
  using (true);

drop policy if exists "dashboards_insert_admin" on public.dashboards;
create policy "dashboards_insert_admin"
  on public.dashboards for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "dashboards_update_admin" on public.dashboards;
create policy "dashboards_update_admin"
  on public.dashboards for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "dashboards_delete_admin" on public.dashboards;
create policy "dashboards_delete_admin"
  on public.dashboards for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- dashboard_status — every authenticated user can view and update candidate
-- status (that is the core purpose of the portal); updated_by/updated_at are
-- stamped server-side by the set_dashboard_status_audit_fields trigger.
-- ---------------------------------------------------------------------------
drop policy if exists "dashboard_status_select" on public.dashboard_status;
create policy "dashboard_status_select"
  on public.dashboard_status for select
  to authenticated
  using (true);

drop policy if exists "dashboard_status_insert" on public.dashboard_status;
create policy "dashboard_status_insert"
  on public.dashboard_status for insert
  to authenticated
  with check (true);

drop policy if exists "dashboard_status_update" on public.dashboard_status;
create policy "dashboard_status_update"
  on public.dashboard_status for update
  to authenticated
  using (true)
  with check (true);
