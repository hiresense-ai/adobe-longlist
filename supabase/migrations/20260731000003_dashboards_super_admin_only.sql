-- Adobe Longlist — dashboard management restricted to Super Admin
--
-- Uploading, replacing, and deleting dashboards (and their files in the
-- `dashboards` storage bucket) move from is_admin() — which is true for
-- both admin and super_admin — to is_super_admin(). Browsing/opening a
-- dashboard is unchanged: select stays open to every authenticated user,
-- so Admin and Viewer keep full read-only access.
--
-- This is the storage/table half of the same RBAC pass that restricted
-- dashboard_status writes in 20260731000002; together they mean an Admin
-- can read every dashboard but write none of it.
--
-- Depends on 20260720000002_rls_policies.sql + 20260720000003_storage.sql
-- (policies replaced here) and 20260730000001_account_security.sql
-- (is_super_admin()).

-- ---------------------------------------------------------------------------
-- public.dashboards
-- ---------------------------------------------------------------------------
drop policy if exists "dashboards_insert_admin" on public.dashboards;
drop policy if exists "dashboards_insert_super_admin" on public.dashboards;
create policy "dashboards_insert_super_admin"
  on public.dashboards for insert
  to authenticated
  with check (public.is_super_admin());

drop policy if exists "dashboards_update_admin" on public.dashboards;
drop policy if exists "dashboards_update_super_admin" on public.dashboards;
create policy "dashboards_update_super_admin"
  on public.dashboards for update
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

drop policy if exists "dashboards_delete_admin" on public.dashboards;
drop policy if exists "dashboards_delete_super_admin" on public.dashboards;
create policy "dashboards_delete_super_admin"
  on public.dashboards for delete
  to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- storage.objects — the `dashboards` bucket (uploaded HTML + thumbnails)
-- ---------------------------------------------------------------------------
drop policy if exists "dashboards_bucket_insert_admin" on storage.objects;
drop policy if exists "dashboards_bucket_insert_super_admin" on storage.objects;
create policy "dashboards_bucket_insert_super_admin"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'dashboards' and public.is_super_admin());

drop policy if exists "dashboards_bucket_update_admin" on storage.objects;
drop policy if exists "dashboards_bucket_update_super_admin" on storage.objects;
create policy "dashboards_bucket_update_super_admin"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'dashboards' and public.is_super_admin())
  with check (bucket_id = 'dashboards' and public.is_super_admin());

drop policy if exists "dashboards_bucket_delete_admin" on storage.objects;
drop policy if exists "dashboards_bucket_delete_super_admin" on storage.objects;
create policy "dashboards_bucket_delete_super_admin"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'dashboards' and public.is_super_admin());
