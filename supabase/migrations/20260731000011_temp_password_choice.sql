-- Adobe Longlist — first-login temporary-password choice.
--
-- force_password_change already means "this account has a password that
-- isn't really the user's own yet" — but today it only has ONE behavior
-- wired to it: ForcePasswordChangeGate hard-blocks the entire app until the
-- user changes it. That is exactly right for an ADMIN RESET (the only path
-- that has ever set it, via admin-users' resetPassword) and must keep
-- working exactly as it does today.
--
-- New user creation with a generated password needs a SECOND behavior from
-- the same starting point: show the user a choice ("change it now" or
-- "continue with the temporary one") instead of an unconditional block, and
-- — if they choose to continue — remember that choice so they are never
-- re-prompted, without ever pretending the password stopped being
-- temporary. A single boolean cannot represent "block" vs "ask" vs "asked,
-- continue" without breaking the existing Reset Password behavior for one
-- of those three states, so this adds one small nullable column rather than
-- overloading force_password_change's existing semantics.
--
-- temp_password_choice:
--   NULL        — not applicable. This is the state for every account
--                 today, and for every future admin-reset (that flow never
--                 touches this column) — ForcePasswordChangeGate's existing
--                 hard-block behavior is completely unchanged for that case.
--   'pending'   — set by admin-users' createUser, only when the admin used
--                 a generated (not manually typed) password. The user has a
--                 temporary password and has not yet been asked what to do
--                 about it.
--   'continued' — the user was shown the choice and picked "Continue with
--                 temporary password". force_password_change stays TRUE
--                 (the password is still temporary — the app must keep
--                 knowing that), but the app no longer blocks or re-prompts.
--
-- Cleared back to NULL by change-password whenever it clears
-- force_password_change to false — the moment the user actually sets a
-- password of their own (whether via "Change password now" from the choice
-- screen, or later through the ordinary Change Password page), both flags
-- resolve together.

alter table public.profiles
  add column if not exists temp_password_choice text
    check (temp_password_choice in ('pending', 'continued'));

comment on column public.profiles.temp_password_choice is
  'Only meaningful while force_password_change is true. NULL = not applicable (every admin-reset password, unchanged hard-block behavior). ''pending'' = generated at user creation, first-login choice not yet made. ''continued'' = user chose to continue with the temporary password; still temporary, but no longer blocks the app. Cleared to NULL by change-password alongside force_password_change.';

-- Same tamper guard as every other password/lockout-state column: writable
-- only where auth.uid() is null (the service-role Edge Functions), never
-- through a user's own profiles_update_own policy. Extends the existing
-- function (full replace, same convention as every prior migration that
-- has touched it) rather than adding a second trigger.
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
  new.temp_password_choice  := old.temp_password_choice;

  return new;
end;
$$;
