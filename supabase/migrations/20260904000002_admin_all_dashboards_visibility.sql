-- Adobe Longlist — Admin sees ALL dashboards (visibility/read only).
--
-- Product rule change, per spec:
--   super_admin — every dashboard (unchanged).
--   admin       — every dashboard (NEW — previously only dashboards they
--                 held a dashboard_assignments row on).
--   viewer      — only dashboards they hold an assignment row on
--                 (unchanged; the assignment filter stays for viewers).
--
-- STRICTLY visibility: only the two SELECT policies below change — the
-- dashboards row and the storage bucket read (HTML + thumbnail), i.e.
-- exactly what "seeing" a dashboard requires. Every write/manage boundary
-- is untouched and still assignment-gates an Admin independently:
--   - dashboards insert/update/delete RLS stays super_admin-only,
--   - the dashboard-edit Edge Function re-checks isAssigned() for an
--     Admin on every call,
--   - the dashboard-assignments Edge Function still requires an Admin to
--     be assigned themselves before listing/managing a roster,
--   - the dashboard-analytics Edge Function still requires an Admin to be
--     assigned (per spec: analytics permissions unchanged).
-- So an Admin can now OPEN any dashboard but gains no new edit, delete,
-- assignment, or analytics capability from this migration.
--
-- is_admin() (init_schema migration) is role = 'admin' exactly — the same
-- security-definer shape as the is_super_admin() already used here, so
-- this cannot recurse into profiles RLS. No "authenticated can read all"
-- hole: viewers still need the assignment subquery to pass.
--
-- Single-tenant deployment: this app has one organization per instance
-- (no tenant column exists anywhere), so "all dashboards" means all in
-- this deployment — there is no cross-tenant surface to leak.

drop policy if exists "dashboards_select" on public.dashboards;
create policy "dashboards_select"
  on public.dashboards for select
  to authenticated
  using (
    public.is_super_admin()
    or public.is_admin()
    or exists (
      select 1
      from public.dashboard_assignments da
      where da.dashboard_id = dashboards.id
        and da.user_id = auth.uid()
    )
  );

-- Storage read must match, or an Admin could list an unassigned dashboard
-- but not load its HTML/thumbnail. The bucket holds only dashboard HTML
-- and thumbnails, so the bare is_admin() arm mirrors exactly what
-- is_super_admin() already grants here.
drop policy if exists "dashboards_bucket_select" on storage.objects;
create policy "dashboards_bucket_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'dashboards'
    and (
      public.is_super_admin()
      or public.is_admin()
      or exists (
        select 1
        from public.dashboards d
        join public.dashboard_assignments da on da.dashboard_id = d.id
        where da.user_id = auth.uid()
          and (d.storage_path = storage.objects.name or d.thumbnail = storage.objects.name)
      )
    )
  );
