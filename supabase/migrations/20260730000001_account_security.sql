-- Adobe Longlist — account security: super_admin role + login lockout
--
-- Additive only. No table or column is dropped and no existing row is
-- rewritten: every new column has a default that matches the pre-migration
-- behaviour (0 failed attempts, not locked), so existing accounts are
-- unaffected until they actually fail a login.
--
-- Depends on 20260720000001_init_schema.sql (profiles, is_admin,
-- handle_new_user, guard_profile_role_change) and
-- 20260721000001_security_hardening.sql (audit_logs).
--
-- The first super_admin is created manually, outside the application: create
-- the auth user in Supabase Auth, then run
--   update public.profiles set role = 'super_admin' where email = '<address>';
-- in the SQL editor. That path has no JWT, so auth.uid() is null and the role
-- guard below deliberately permits it — see guard_profile_role_change().

-- ---------------------------------------------------------------------------
-- profiles.role: allow 'super_admin'
--
-- The original constraint was declared inline, so its name is whatever
-- Postgres generated. Drop by lookup rather than by a guessed name so this
-- migration doesn't silently no-op on a database where it differs.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'admin', 'viewer'));

-- ---------------------------------------------------------------------------
-- profiles: login lockout state
--
-- Kept on profiles rather than a side table so a single read during login
-- returns both the role (needed to decide whether the account can lock at
-- all) and the counter. locked_at doubles as the flag and the timestamp —
-- null means active.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists last_failed_login_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_failed_login_attempts_nonneg;
alter table public.profiles
  add constraint profiles_failed_login_attempts_nonneg
  check (failed_login_attempts >= 0);

comment on column public.profiles.failed_login_attempts is
  'Consecutive failed password attempts. Reset to 0 on any successful login. Maintained only by the auth-login Edge Function (service role).';
comment on column public.profiles.locked_at is
  'When the account was locked out. Null = active. super_admin accounts are never auto-locked.';

-- Login looks the account up by email before any password check, so keep that
-- lookup indexed and case-insensitive to match how addresses are compared.
create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

-- Rate limiting in auth-login counts recent failures for one address.
create index if not exists audit_logs_target_email_idx
  on public.audit_logs (target_email, created_at desc);

-- ---------------------------------------------------------------------------
-- Role helpers
--
-- is_admin() deliberately returns true for super_admin as well. Every
-- pre-existing RLS policy and rate-limit trigger is written in terms of
-- is_admin(), so widening it here is what keeps a super admin's dashboard,
-- storage and audit-log access working without touching those policies.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'super_admin')
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Role-change guard
--
-- Reverts the attempted change rather than raising, matching the existing
-- trigger's behaviour (a blocked escalation is a silent no-op, not a 500).
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  -- No JWT context: the SQL editor, psql, a migration, or a service-role
  -- client (the Edge Functions, which run their own authorization first).
  -- This is also how the first super_admin is promoted by hand.
  if auth.uid() is null then
    return new;
  end if;

  select role into actor_role from public.profiles where id = auth.uid();

  -- Granting or revoking super_admin — including demoting an existing one —
  -- is reserved for super admins. An admin must not be able to mint a peer
  -- above themselves, or strip the only account that can unlock them.
  if (new.role = 'super_admin' or old.role = 'super_admin')
     and coalesce(actor_role, '') <> 'super_admin' then
    new.role := old.role;
    return new;
  end if;

  if coalesce(actor_role, '') not in ('admin', 'super_admin') then
    new.role := old.role;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_role_change on public.profiles;
create trigger profiles_guard_role_change
  before update on public.profiles
  for each row execute function public.guard_profile_role_change();

-- ---------------------------------------------------------------------------
-- Lockout-column guard
--
-- profiles_update_own lets any user update their own row, which would
-- otherwise let a locked account simply PATCH locked_at back to null (or zero
-- its own counter mid-attack) straight through PostgREST. These three columns
-- are therefore writable only where auth.uid() is null — i.e. the service-role
-- Edge Functions, which do their own authorization before touching them.
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
  new.locked_at := old.locked_at;
  new.last_failed_login_at := old.last_failed_login_at;
  return new;
end;
$$;

drop trigger if exists profiles_guard_lock_columns on public.profiles;
create trigger profiles_guard_lock_columns
  before update on public.profiles
  for each row execute function public.guard_profile_lock_columns();

-- ---------------------------------------------------------------------------
-- Signup trigger: never honour 'super_admin' from user metadata
--
-- handle_new_user() copies raw_user_meta_data->>'role' straight onto the
-- profile. That value is attacker-controlled on any self-signup path, so it
-- is now clamped to the two roles that are safe to request. admin-users
-- assigns the real role afterwards with the service role, which is unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role text;
begin
  requested_role := coalesce(new.raw_user_meta_data ->> 'role', 'viewer');
  if requested_role not in ('admin', 'viewer') then
    requested_role := 'viewer';
  end if;

  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'name',
    requested_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
