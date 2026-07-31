-- Adobe Longlist — Super Admin visibility + candidate-status RBAC
--
-- Two independent tightenings, both requested together as one RBAC pass:
--
-- 1. profiles_select: an Admin (not Super Admin) must never be able to
--    retrieve a Super Admin's profile row, through ANY path — not just the
--    admin-users edge function's own listUsers filtering (which only
--    covers the app's own UI), but also a direct PostgREST/Supabase-client
--    query using the Admin's own session, which RLS is what actually
--    guards. is_super_admin() already existed (account_security
--    migration) but was never referenced by any policy until now.
--
-- 2. dashboard_status insert/update: candidate status/action updates are
--    now Super Admin only (previously any authenticated user, viewer
--    included, by original design — see the comment this replaces in
--    20260720000002_rls_policies.sql). select stays open to every
--    authenticated user: viewing a dashboard's candidate statuses remains
--    read-only access for Admin/Viewer, only writing is restricted.
--
-- Depends on 20260720000002_rls_policies.sql (policies replaced here) and
-- 20260730000001_account_security.sql (is_super_admin()).

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select"
  on public.profiles for select
  to authenticated
  using (
    auth.uid() = id
    or public.is_super_admin()
    or (public.is_admin() and role <> 'super_admin')
  );

drop policy if exists "dashboard_status_insert" on public.dashboard_status;
create policy "dashboard_status_insert"
  on public.dashboard_status for insert
  to authenticated
  with check (public.is_super_admin());

drop policy if exists "dashboard_status_update" on public.dashboard_status;
create policy "dashboard_status_update"
  on public.dashboard_status for update
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());
