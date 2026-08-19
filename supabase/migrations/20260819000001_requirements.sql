-- Adobe Longlist — Requirements (job requirement / JD submissions).
--
-- Additive only. A dedicated table, deliberately independent of every
-- dashboard/candidate table — requirements are their own lifecycle
-- (Pending → Contacted → In Progress → Completed), not candidate data.
--
-- ACCESS MODEL — Edge-Function-only, by design:
--
-- RLS is enabled with NO policies for regular clients, so every direct
-- PostgREST/supabase-js query against this table is denied. All reads and
-- writes go through the `requirements` Edge Function (service role), which
-- is the one place the full rule set lives:
--
--   super_admin — sees/edits everything, owns every status transition.
--   admin       — sees every requirement in full at every stage; may edit
--                 only while status = 'Pending'; never changes status.
--   viewer      — sees only their own requirements; full details while
--                 'Pending', summary-only (no jd_text/jd_url/contact
--                 fields) once contacted; may edit own 'Pending' rows only.
--
-- Row-level RLS could express "viewer sees own rows", but NOT the
-- field-level rule ("viewer loses jd_text/jd_url/contact_notes after
-- Contacted") — Postgres has no per-row column masking. A viewer with a
-- SELECT policy could always read every column of a visible row through
-- the client. Locking the table down entirely and shaping the response in
-- the Edge Function is the only arrangement where the restricted fields
-- never reach a viewer's browser at all, which is the explicit security
-- requirement for this feature. Same pattern as dashboard_assignments'
-- writes and admin-users: the service-role function is the boundary, and
-- deny-all RLS guarantees there's no second, unguarded path around it.

create table if not exists public.requirements (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  jd_text       text,
  jd_url        text,
  status        text not null default 'Pending',
  created_by    uuid not null references public.profiles (id) on delete cascade,
  contacted_by  uuid references public.profiles (id) on delete set null,
  contacted_at  timestamptz,
  contact_notes text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Exactly the four workflow statuses, in their display form — no
  -- arbitrary strings. (Order lives in the Edge Function; the DB only
  -- guards the value set.)
  constraint requirements_status_check check (
    status in ('Pending', 'Contacted', 'In Progress', 'Completed')
  ),
  -- A requirement must carry a JD in some form — text, link, or both.
  constraint requirements_jd_present check (
    jd_text is not null or jd_url is not null
  ),
  constraint requirements_title_length check (char_length(title) <= 200),
  constraint requirements_jd_text_length check (
    jd_text is null or char_length(jd_text) <= 20000
  ),
  constraint requirements_jd_url_length check (
    jd_url is null or char_length(jd_url) <= 2048
  ),
  constraint requirements_contact_notes_length check (
    contact_notes is null or char_length(contact_notes) <= 2000
  )
);

comment on table public.requirements is 'Job requirement / JD submissions. Edge-Function-only access (see the requirements function) — RLS is enabled with no client policies on purpose, so the viewer field-level visibility rules cannot be bypassed with a direct client query.';

create index if not exists requirements_created_by_idx on public.requirements (created_by, created_at desc);
create index if not exists requirements_status_idx on public.requirements (status);
create index if not exists requirements_created_at_idx on public.requirements (created_at desc);

-- Deny-all for clients: enabled RLS + zero policies. The service-role
-- Edge Function bypasses RLS; nothing else gets in.
alter table public.requirements enable row level security;

-- updated_at is stamped by trigger so the service can't forget it and the
-- client can't forge it. (created_by/contacted_by are set explicitly by
-- the Edge Function from the verified caller — auth.uid() is null under
-- the service role, so a candidate_notes-style auth.uid() trigger would
-- not work here.)
create or replace function public.set_requirements_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists requirements_set_updated_at on public.requirements;
create trigger requirements_set_updated_at
  before update on public.requirements
  for each row execute function public.set_requirements_updated_at();
