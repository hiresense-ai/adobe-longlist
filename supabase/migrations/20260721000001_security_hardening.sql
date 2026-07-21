-- Adobe Longlist — security hardening
-- Additive only: no columns/tables are dropped, no existing data is touched,
-- no existing policy that the app relies on is removed. Depends on
-- 20260720000001_init_schema.sql, 20260720000002_rls_policies.sql,
-- 20260720000003_storage.sql.

-- ---------------------------------------------------------------------------
-- Storage: stop accepting SVG (script-capable image format — a signed URL
-- opened directly would execute embedded JS in the storage origin) and bring
-- the bucket ceiling down to the largest single file the app ever uploads
-- (10 MB HTML). Per-type limits (10 MB html / 5 MB thumbnail) are still
-- enforced in the client before upload; this is the server-side backstop.
-- ---------------------------------------------------------------------------
update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['text/html', 'image/png', 'image/jpeg', 'image/webp']
where id = 'dashboards';

-- ---------------------------------------------------------------------------
-- profiles: a user (viewer OR admin) could previously update their own
-- `email` column directly through the client SDK (RLS only blocked `role`
-- escalation), desyncing profiles.email from the real auth.users.email — the
-- exact bug that broke the admin's login before the admin-users Edge
-- Function existed. Unlike role (where an admin editing their own row is
-- fine), there's no legitimate reason for ANY authenticated-session update to
-- change email directly — the only supported path is the admin-users Edge
-- Function's service-role client (auth.uid() is null there, so it is
-- unaffected by this guard).
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email and auth.uid() is not null then
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_email_change on public.profiles;
create trigger profiles_guard_email_change
  before update on public.profiles
  for each row execute function public.guard_profile_email_change();

-- ---------------------------------------------------------------------------
-- Reasonable length ceilings so a compromised iframe / bad actor can't stuff
-- unbounded strings into these columns. Generous relative to real usage —
-- existing rows are all far under these limits.
-- ---------------------------------------------------------------------------
alter table public.dashboards
  add constraint dashboards_title_length check (char_length(title) <= 200),
  add constraint dashboards_description_length check (description is null or char_length(description) <= 2000),
  add constraint dashboards_category_length check (category is null or char_length(category) <= 100);

alter table public.dashboard_status
  add constraint dashboard_status_candidate_name_length check (char_length(candidate_name) <= 200),
  add constraint dashboard_status_remarks_length check (remarks is null or char_length(remarks) <= 2000);

-- ---------------------------------------------------------------------------
-- audit_logs — tamper-resistant activity trail.
-- No insert/update/delete policy for authenticated/anon roles at all, so the
-- only way a row gets written is via a security-definer trigger function
-- (below) or the admin-users Edge Function's service-role client. Only
-- admins may read it.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  actor_id      uuid references public.profiles (id) on delete set null,
  actor_email   text,
  action        text not null,
  target_type   text,
  target_id     text,
  target_email  text,
  metadata      jsonb not null default '{}'::jsonb,
  success       boolean not null default true
);

comment on table public.audit_logs is 'Append-only security/audit trail. Written only by security-definer triggers or the service-role admin-users Edge Function — never directly by clients.';

create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action, created_at desc);

alter table public.audit_logs enable row level security;

drop policy if exists "audit_logs_select_admin" on public.audit_logs;
create policy "audit_logs_select_admin"
  on public.audit_logs for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Dashboard upload/delete: audit every event (actor comes from auth.uid(),
-- which is populated correctly here since these go through the user's own
-- authenticated session, unlike the service-role Edge Function) and enforce
-- a simple per-user rate limit so a leaked/compromised admin session can't
-- be scripted into mass-uploading or mass-deleting dashboards.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_dashboard_upload_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  if auth.uid() is null then
    return new; -- service-role / migration context: not rate-limited
  end if;

  select count(*) into recent_count
  from public.audit_logs
  where actor_id = auth.uid()
    and action = 'dashboard.upload'
    and created_at > now() - interval '10 minutes';

  if recent_count >= 10 then
    raise exception 'Rate limit exceeded: too many dashboard uploads. Please wait a few minutes and try again.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists dashboards_rate_limit_insert on public.dashboards;
create trigger dashboards_rate_limit_insert
  before insert on public.dashboards
  for each row execute function public.enforce_dashboard_upload_rate_limit();

create or replace function public.enforce_dashboard_delete_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  if auth.uid() is null then
    return old;
  end if;

  select count(*) into recent_count
  from public.audit_logs
  where actor_id = auth.uid()
    and action = 'dashboard.delete'
    and created_at > now() - interval '10 minutes';

  if recent_count >= 20 then
    raise exception 'Rate limit exceeded: too many dashboard deletions. Please wait a few minutes and try again.'
      using errcode = 'P0001';
  end if;

  return old;
end;
$$;

drop trigger if exists dashboards_rate_limit_delete on public.dashboards;
create trigger dashboards_rate_limit_delete
  before delete on public.dashboards
  for each row execute function public.enforce_dashboard_delete_rate_limit();

create or replace function public.log_dashboard_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values (auth.uid(), 'dashboard.upload', 'dashboard', new.id::text, jsonb_build_object('title', new.title));
    return new;
  elsif TG_OP = 'DELETE' then
    insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values (auth.uid(), 'dashboard.delete', 'dashboard', old.id::text, jsonb_build_object('title', old.title));
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists dashboards_audit_insert on public.dashboards;
create trigger dashboards_audit_insert
  after insert on public.dashboards
  for each row execute function public.log_dashboard_audit();

drop trigger if exists dashboards_audit_delete on public.dashboards;
create trigger dashboards_audit_delete
  after delete on public.dashboards
  for each row execute function public.log_dashboard_audit();
