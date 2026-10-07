-- LYCA MOBILE ONLY — applied to the Lyca Supabase project, never to Adobe's.
-- (scripts/lyca-local.mjs appends workspaces/lyca/migrations to the shared
-- supabase/migrations when it builds the Lyca stack; Adobe's CLI never reads
-- this folder.)
--
-- Lyca reuses Adobe's schema and authorization model unchanged, except for
-- two weaknesses this migration does not carry over:
--
-- 1. Candidate statuses/actions (dashboard_status) and candidate notes
--    (candidate_notes) are readable and writable by ANY authenticated user
--    for ANY dashboard id in Adobe's schema (policies using/with check
--    `true`, see 20260720000002_rls_policies.sql, 20260731000009_open_
--    candidate_status_writes.sql, 20260731000014_candidate_notes.sql). Here
--    they follow the same rule as the dashboard itself (dashboards_select):
--    Super Admin and Admin — any dashboard; Viewer — only dashboards assigned
--    to them. Applies to reads, inserts, updates and Realtime events alike.
--
-- 2. An UPDATE could rewrite a row's identity/audit columns: move a
--    status/note to another dashboard or candidate, or overwrite a note's
--    created_by/created_at. Those are now fixed once written (updated_by/
--    updated_at were, and remain, stamped server-side by the existing
--    *_set_audit_fields triggers; candidate_action_logs stays trigger-written
--    and has no client policies at all).

create or replace function public.can_access_dashboard(p_dashboard_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  -- Exactly the dashboards_select rule, for one dashboard id.
  select public.is_super_admin()
      or public.is_admin()
      or exists (
        select 1
        from public.dashboard_assignments da
        where da.dashboard_id = p_dashboard_id
          and da.user_id = auth.uid()
      );
$$;

revoke all on function public.can_access_dashboard(uuid) from public;
-- Explicitly too: the project's default privileges grant EXECUTE on every
-- new function to anon.
revoke execute on function public.can_access_dashboard(uuid) from anon;
grant execute on function public.can_access_dashboard(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- dashboard_status
-- ---------------------------------------------------------------------------
drop policy if exists "dashboard_status_select" on public.dashboard_status;
create policy "dashboard_status_select"
  on public.dashboard_status for select
  to authenticated
  using (public.can_access_dashboard(dashboard_id));

drop policy if exists "dashboard_status_insert" on public.dashboard_status;
create policy "dashboard_status_insert"
  on public.dashboard_status for insert
  to authenticated
  with check (public.can_access_dashboard(dashboard_id));

drop policy if exists "dashboard_status_update" on public.dashboard_status;
create policy "dashboard_status_update"
  on public.dashboard_status for update
  to authenticated
  using (public.can_access_dashboard(dashboard_id))
  with check (public.can_access_dashboard(dashboard_id));

-- ---------------------------------------------------------------------------
-- candidate_notes
-- ---------------------------------------------------------------------------
drop policy if exists "candidate_notes_select" on public.candidate_notes;
create policy "candidate_notes_select"
  on public.candidate_notes for select
  to authenticated
  using (public.can_access_dashboard(dashboard_id));

drop policy if exists "candidate_notes_insert" on public.candidate_notes;
create policy "candidate_notes_insert"
  on public.candidate_notes for insert
  to authenticated
  with check (public.can_access_dashboard(dashboard_id));

drop policy if exists "candidate_notes_update" on public.candidate_notes;
create policy "candidate_notes_update"
  on public.candidate_notes for update
  to authenticated
  using (public.can_access_dashboard(dashboard_id))
  with check (public.can_access_dashboard(dashboard_id));

-- ---------------------------------------------------------------------------
-- Identity/audit columns are fixed once written. The app only ever upserts
-- on (dashboard_id, candidate_name), which never changes either.
-- ---------------------------------------------------------------------------
create or replace function public.lock_candidate_row_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.dashboard_id is distinct from old.dashboard_id
     or new.candidate_name is distinct from old.candidate_name then
    raise exception 'A candidate row''s dashboard and candidate cannot be changed'
      using errcode = '42501';
  end if;
  if TG_TABLE_NAME = 'candidate_notes' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists dashboard_status_lock_identity on public.dashboard_status;
create trigger dashboard_status_lock_identity
  before update on public.dashboard_status
  for each row execute function public.lock_candidate_row_identity();

drop trigger if exists candidate_notes_lock_identity on public.candidate_notes;
create trigger candidate_notes_lock_identity
  before update on public.candidate_notes
  for each row execute function public.lock_candidate_row_identity();
