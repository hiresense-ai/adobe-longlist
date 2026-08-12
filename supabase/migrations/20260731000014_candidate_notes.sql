-- Adobe Longlist — standalone Candidate Notes.
--
-- Additive only, and deliberately independent of dashboard_status.remarks
-- (which the existing Screen Select/Reject HR comment already owns — see
-- 20260731000013_screen_actions.sql). No suitable existing notes/comment
-- storage was found elsewhere in the schema, so this is a new table,
-- following the exact same shape/conventions as dashboard_status:
--   - candidates have no first-class id anywhere in this schema, so
--     identity is the same (dashboard_id, candidate_name) pair
--     dashboard_status already uses, not a fabricated candidate_id.
--   - one row per candidate (UNIQUE dashboard_id, candidate_name), upserted
--     in place — the product surface (see dashboard-bridge.js) is a single
--     editable Notes area per candidate, not a note history/thread.
--   - updated_by/updated_at (and here created_by/created_at too) are
--     stamped server-side by a trigger, never trusted from the client —
--     identical reasoning to set_dashboard_status_audit_fields().
--   - RLS: open to every authenticated user, mirroring
--     dashboard_status_select/_insert/_update exactly (candidate-detail
--     permissions are reused as-is, per the "reuse the existing
--     candidate-action/candidate-detail permission model, do not
--     introduce new RBAC roles" requirement — dashboard-level visibility
--     is still gated by dashboard_assignments, same as status/action).
--   - realtime published, mirroring dashboard_status, so two HR users
--     viewing the same dashboard stay in sync exactly like status/action
--     already do.

create table if not exists public.candidate_notes (
  id             uuid primary key default gen_random_uuid(),
  dashboard_id   uuid not null references public.dashboards (id) on delete cascade,
  candidate_name text not null,
  note           text,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),

  constraint candidate_notes_candidate_unique unique (dashboard_id, candidate_name),
  constraint candidate_notes_candidate_name_length check (char_length(candidate_name) <= 200),
  constraint candidate_notes_note_length check (note is null or char_length(note) <= 2000)
);

comment on table public.candidate_notes is 'Independent HR note per candidate per dashboard — separate from dashboard_status.remarks (owned by the Screen Select/Reject comment). One editable note per candidate, not a thread/history.';

create index if not exists candidate_notes_dashboard_id_idx on public.candidate_notes (dashboard_id);

alter table public.candidate_notes enable row level security;

drop policy if exists "candidate_notes_select" on public.candidate_notes;
create policy "candidate_notes_select"
  on public.candidate_notes for select
  to authenticated
  using (true);

drop policy if exists "candidate_notes_insert" on public.candidate_notes;
create policy "candidate_notes_insert"
  on public.candidate_notes for insert
  to authenticated
  with check (true);

drop policy if exists "candidate_notes_update" on public.candidate_notes;
create policy "candidate_notes_update"
  on public.candidate_notes for update
  to authenticated
  using (true)
  with check (true);

create or replace function public.set_candidate_notes_audit_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists candidate_notes_set_audit_fields on public.candidate_notes;
create trigger candidate_notes_set_audit_fields
  before insert or update on public.candidate_notes
  for each row execute function public.set_candidate_notes_audit_fields();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'candidate_notes'
  ) then
    alter publication supabase_realtime add table public.candidate_notes;
  end if;
end;
$$;
