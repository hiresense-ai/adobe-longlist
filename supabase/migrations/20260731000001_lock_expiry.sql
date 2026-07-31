-- Adobe Longlist — random-duration lock expiry
--
-- Additive: one new column, no existing row rewritten. Every current row
-- gets lock_expires_at = null, matching its existing (not-expiring) lock
-- state exactly — nobody currently locked becomes newly unlockable by
-- this migration alone.
--
-- Depends on 20260730000001_account_security.sql (locked_at,
-- failed_login_attempts, guard_profile_lock_columns()).
--
-- Design: there is no scheduled job that sweeps expired locks. Automatic
-- unlock is applied lazily, at the two points that actually read lock
-- state — auth-login (a real login attempt) and admin-users' listUsers (the
-- admin UI) — both compare lock_expires_at to now() themselves. A cron-based
-- sweep would just be extra moving parts to keep in sync with the same
-- comparison these already have to make regardless (an account that never
-- attempts to log in again, and whose Users row nobody views again, has no
-- observable difference between "swept immediately at expiry" and "swept
-- lazily next time someone looks" — so the sweep would add zero real value).

alter table public.profiles
  add column if not exists lock_expires_at timestamptz;

comment on column public.profiles.lock_expires_at is
  'When an active lock (locked_at) expires and the account is treated as unlocked again. Null when not locked. A random 10-20 minute duration is chosen at lock time by auth-login; expiry is applied lazily wherever lock state is read, not by a scheduled sweep.';

-- Extends the existing tamper guard (see account_security migration) to
-- cover the new column too — same rule: writable only where auth.uid() is
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
  new.locked_at := old.locked_at;
  new.lock_expires_at := old.lock_expires_at;
  new.last_failed_login_at := old.last_failed_login_at;
  return new;
end;
$$;

drop trigger if exists profiles_guard_lock_columns on public.profiles;
create trigger profiles_guard_lock_columns
  before update on public.profiles
  for each row execute function public.guard_profile_lock_columns();
