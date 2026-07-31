-- Adobe Longlist — password-reset audit trail + API lockout while a forced
-- password change is pending.
--
-- Two independent additions from the same enterprise-auth audit:
--
-- 1. profiles.password_reset_at / password_reset_by: who reset this
--    account's password (via an admin reset) and when. force_password_change
--    is the ACTIONABLE flag the app gates on; these two are a permanent
--    audit trail and are deliberately never cleared by change-password —
--    they answer "was this account's password ever admin-reset, by whom,
--    and when," which stays true after the user picks their own password.
--
-- 2. is_active_super_admin(): every RLS policy and the require_super_admin_
--    write() trigger (20260731000004) currently gate writes on
--    is_super_admin() alone. A Super Admin whose OWN password was reset by
--    another Super Admin (the one case resetPassword permits against a
--    super_admin target) still passes is_super_admin() before they have
--    completed their forced password change — meaning direct table/storage
--    writes were reachable during that window even though the app's own
--    UI (ForcePasswordChangeGate) blocks it and the admin-users Edge
--    Function's own privileged actions are separately blocked by the same
--    check added there. This closes that gap at the RLS layer itself,
--    which is the actual boundary a direct API call (bypassing the UI and
--    the admin-users function entirely) would hit.
--
--    Deliberately a NEW function rather than changing is_super_admin()
--    itself: that function is also relied on for read/visibility
--    decisions (profiles_select, the admin-users Edge Function's own
--    caller-role check) where "have you completed your forced password
--    change yet" is not the relevant question — only WRITE authorization
--    needs it.

alter table public.profiles
  add column if not exists password_reset_at timestamptz;
alter table public.profiles
  add column if not exists password_reset_by uuid references public.profiles (id) on delete set null;

comment on column public.profiles.password_reset_at is
  'When an administrator last reset this account''s password (admin-users resetPassword, only for a target other than the caller). Null if never admin-reset. Never cleared by change-password — a permanent audit trail, unlike force_password_change.';
comment on column public.profiles.password_reset_by is
  'Which admin last reset this account''s password. Null if never admin-reset, or if that admin''s own account has since been deleted (on delete set null).';

-- Extends the existing tamper guard to cover the two new columns too — same
-- rule as every other guarded column: writable only where auth.uid() is
-- null (the service-role Edge Functions), never through a user's own
-- profiles_update_own policy.
create or replace function public.guard_profile_lock_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  new.failed_login_attempts := old.failed_login_attempts;
  new.locked_at             := old.locked_at;
  new.lock_expires_at       := old.lock_expires_at;
  new.last_failed_login_at  := old.last_failed_login_at;
  new.force_password_change := old.force_password_change;
  new.password_reset_at     := old.password_reset_at;
  new.password_reset_by     := old.password_reset_by;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- is_active_super_admin(): is_super_admin() AND the account has no pending
-- forced password change. Used ONLY for write authorization (see above) —
-- never for read/visibility checks, which stay on is_super_admin()/is_admin().
-- ---------------------------------------------------------------------------
create or replace function public.is_active_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_super_admin()
    and not coalesce(
      (select force_password_change from public.profiles where id = auth.uid()),
      false
    );
$$;

-- dashboards
drop policy if exists "dashboards_insert_super_admin" on public.dashboards;
create policy "dashboards_insert_super_admin"
  on public.dashboards for insert
  to authenticated
  with check (public.is_active_super_admin());

drop policy if exists "dashboards_update_super_admin" on public.dashboards;
create policy "dashboards_update_super_admin"
  on public.dashboards for update
  to authenticated
  using (public.is_active_super_admin())
  with check (public.is_active_super_admin());

drop policy if exists "dashboards_delete_super_admin" on public.dashboards;
create policy "dashboards_delete_super_admin"
  on public.dashboards for delete
  to authenticated
  using (public.is_active_super_admin());

-- dashboard_status
drop policy if exists "dashboard_status_insert" on public.dashboard_status;
create policy "dashboard_status_insert"
  on public.dashboard_status for insert
  to authenticated
  with check (public.is_active_super_admin());

drop policy if exists "dashboard_status_update" on public.dashboard_status;
create policy "dashboard_status_update"
  on public.dashboard_status for update
  to authenticated
  using (public.is_active_super_admin())
  with check (public.is_active_super_admin());

-- storage: the `dashboards` bucket
drop policy if exists "dashboards_bucket_insert_super_admin" on storage.objects;
create policy "dashboards_bucket_insert_super_admin"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'dashboards' and public.is_active_super_admin());

drop policy if exists "dashboards_bucket_update_super_admin" on storage.objects;
create policy "dashboards_bucket_update_super_admin"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'dashboards' and public.is_active_super_admin())
  with check (bucket_id = 'dashboards' and public.is_active_super_admin());

drop policy if exists "dashboards_bucket_delete_super_admin" on storage.objects;
create policy "dashboards_bucket_delete_super_admin"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'dashboards' and public.is_active_super_admin());

-- The statement-level trigger (20260731000004) that turns a denied
-- UPDATE/DELETE into a real 403 instead of a silent "0 rows changed" 200 —
-- same is_super_admin() -> is_active_super_admin() swap, so the error
-- surfaces correctly for this case too, not just for a plain non-super-admin.
create or replace function public.require_super_admin_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_active_super_admin() then
    raise exception using
      errcode = '42501',
      message = 'Only a Super Admin can modify ' || tg_table_name || '.';
  end if;
  return null;
end;
$$;
