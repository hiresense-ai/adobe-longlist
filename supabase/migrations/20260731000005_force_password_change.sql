-- Adobe Longlist — internal password management
--
-- This portal drops the email-based password reset flow entirely (no email,
-- no OTP, no reset links). Passwords are either changed by the account
-- holder (with their current password) or reset by an administrator, who
-- hands the temporary password over out of band.
--
-- force_password_change is set by the admin-users Edge Function whenever an
-- administrator resets someone else's password, and cleared by the
-- change-password Edge Function once that user picks their own. The app
-- blocks every route until it is false again.

alter table public.profiles
  add column if not exists force_password_change boolean not null default false;

comment on column public.profiles.force_password_change is
  'True after an administrator reset this account''s password. The app forces a self-service password change on next login and clears it via the change-password Edge Function.';

-- ---------------------------------------------------------------------------
-- A user must not be able to clear their own force_password_change flag with
-- a raw PostgREST update and walk straight past the gate. Same convention as
-- guard_profile_lock_columns: auth.uid() IS NULL means service_role (the Edge
-- Functions), which is the only context allowed to change it.
--
-- Replaces the lock-column guard from 20260731000001 rather than adding a
-- second trigger, so both checks stay in one place and fire in one pass.
-- ---------------------------------------------------------------------------
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

  return new;
end;
$$;
