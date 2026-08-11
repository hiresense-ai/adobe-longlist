-- Adobe Longlist — revert the first-login temporary-password CHOICE.
--
-- Supersedes 20260731000011_temp_password_choice.sql. The product decision
-- changed: a newly created user's generated password must behave exactly
-- like an administrator's Reset Password — an unconditional hard block via
-- force_password_change until the account holder sets their own — with no
-- "continue with the temporary one" option at all. That was the entire
-- reason temp_password_choice existed (to distinguish "block" from "ask"
-- from "asked, continuing"); with the choice itself gone, so is the need
-- for a second column. force_password_change alone is once again the
-- single, sufficient signal — same column, same semantics, same gate,
-- unconditionally, for BOTH an admin reset and a generated-password
-- creation. See admin-users' createUser and ForcePasswordChangeGate.
--
-- Applied AFTER 20260731000011 in a real environment (that migration did
-- reach the live database before this reversal), so this drops forward
-- rather than editing that file's already-applied history.

alter table public.profiles
  drop column if exists temp_password_choice;

-- Reverts guard_profile_lock_columns() to the shape it had before
-- 20260731000011 added temp_password_choice to its protected-column list —
-- identical to the version in 20260731000007_password_reset_audit_and_api_lockout.sql.
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
