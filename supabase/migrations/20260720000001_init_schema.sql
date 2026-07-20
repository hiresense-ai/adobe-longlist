-- Adobe Longlist — core schema
-- Run in the Supabase SQL editor, or via `supabase db push` if using the CLI.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  email       text not null,
  role        text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user, created automatically on sign up.';

-- ---------------------------------------------------------------------------
-- dashboards
-- ---------------------------------------------------------------------------
create table if not exists public.dashboards (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  file_name     text not null,
  storage_path  text not null unique,
  thumbnail     text,
  category      text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table public.dashboards is 'Metadata for each HTML dashboard file stored in the "dashboards" storage bucket.';

create index if not exists dashboards_category_idx on public.dashboards (category);

-- ---------------------------------------------------------------------------
-- dashboard_status
-- ---------------------------------------------------------------------------
create table if not exists public.dashboard_status (
  id              uuid primary key default gen_random_uuid(),
  dashboard_id    uuid not null references public.dashboards (id) on delete cascade,
  candidate_name  text not null,
  candidate_email text,
  status          text not null default 'Pending' check (
    status in (
      'Pending',
      'Interview Scheduled',
      'Interview Completed',
      'Selected',
      'Rejected',
      'Hold',
      'Offer Released',
      'Joined'
    )
  ),
  remarks     text,
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),

  constraint dashboard_status_candidate_unique unique (dashboard_id, candidate_name)
);

comment on table public.dashboard_status is 'Latest tracked status per candidate per dashboard. Updated in realtime from the dashboard viewer.';

create index if not exists dashboard_status_dashboard_id_idx on public.dashboard_status (dashboard_id);

-- ---------------------------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'name',
    coalesce(new.raw_user_meta_data ->> 'role', 'viewer')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keep dashboard_status.updated_at / updated_by trustworthy
-- ---------------------------------------------------------------------------
create or replace function public.set_dashboard_status_audit_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists dashboard_status_set_audit_fields on public.dashboard_status;
create trigger dashboard_status_set_audit_fields
  before insert or update on public.dashboard_status
  for each row execute function public.set_dashboard_status_audit_fields();

-- ---------------------------------------------------------------------------
-- Prevent non-admins from escalating their own role
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
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is only non-null inside a PostgREST request (i.e. the app,
  -- authenticated as some user). Direct SQL access (the SQL editor, psql,
  -- migrations, a service-role job) has no JWT context at all, so auth.uid()
  -- is null there — that's how the first admin gets bootstrapped. Only block
  -- the change when a *non-admin app user* is trying to escalate themselves.
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
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
-- Realtime: broadcast changes to candidate statuses
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dashboard_status'
  ) then
    alter publication supabase_realtime add table public.dashboard_status;
  end if;
end;
$$;
