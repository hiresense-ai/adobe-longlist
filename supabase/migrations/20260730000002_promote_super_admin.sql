-- Adobe Longlist — idempotent Super Admin promotion
--
-- Creates NOTHING and contains no password. Per explicit instruction, the
-- initial Super Admin account (admin@hiresense.ai) is created by hand,
-- outside the application — Supabase Dashboard or the Admin API, with its
-- own password meeting the same 12-character policy every other account
-- must meet. This migration only ensures that whichever profile has that
-- email ends up in the exact state a Super Admin is supposed to be in:
-- role = 'super_admin', unlocked, zeroed failed-attempt counter.
--
-- Safe regardless of ordering:
--   - Applied before the account exists: matches zero rows, no-op.
--   - Applied after: promotes/repairs it.
--   - Applied again later (e.g. a fresh environment, or after someone
--     accidentally edited the role back): re-affirms the same state.
-- The where-clause is scoped to this one exact email, so this can only ever
-- act on that single row — it cannot create or touch any other account, and
-- therefore cannot mint an additional Super Admin.
--
-- Depends on 20260730000001_account_security.sql (the 'super_admin' role
-- value and the failed_login_attempts/locked_at columns).
--
-- Full Super Admin permissions follow from role = 'super_admin' alone —
-- is_admin()/is_super_admin() and every RLS policy already key off it (see
-- that migration), and auth-login already never locks that role out
-- regardless of failed_login_attempts. Nothing further to grant here.

do $$
declare
  affected integer;
begin
  update public.profiles
  set role = 'super_admin',
      locked_at = null,
      failed_login_attempts = 0
  where lower(email) = lower('admin@hiresense.ai')
    and (
      role is distinct from 'super_admin'
      or locked_at is not null
      or failed_login_attempts <> 0
    );

  get diagnostics affected = row_count;

  if affected > 0 then
    raise notice 'Promoted admin@hiresense.ai to super_admin (active, unlocked, 0 failed attempts).';
  elsif exists (
    select 1 from public.profiles where lower(email) = lower('admin@hiresense.ai')
  ) then
    raise notice 'admin@hiresense.ai already has the correct super_admin state — nothing to change.';
  else
    raise notice 'admin@hiresense.ai does not exist yet. Create it by hand (Supabase Dashboard or Admin API) with a password meeting the 12-character policy, then re-apply this migration (or run the same UPDATE directly) to promote it.';
  end if;
end;
$$;
