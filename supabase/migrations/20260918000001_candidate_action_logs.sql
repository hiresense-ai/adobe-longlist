-- Adobe Longlist — audit log for candidate Action changes.
--
-- Records WHO changed a candidate's Action (the "Select Action" dropdown on
-- the Dashboard Candidates table) and WHEN, as a permanent, append-only
-- history — independent of dashboard_status.action itself, which only ever
-- holds the CURRENT value.
--
-- Architecture, traced from the existing implementation before writing any
-- of this:
--
--   Dashboard Candidates "Select Action" dropdown
--     -> dashboard-bridge.js (inside the sandboxed iframe) posts
--        longlist:action-update
--     -> useDashboardStatusBridge's handleMessage (React host,
--        src/hooks/useDashboardStatusBridge.tsx)
--     -> upsertCandidateAction() (src/services/dashboardStatus.service.ts)
--     -> supabase.from('dashboard_status').upsert(...) — a DIRECT CLIENT
--        write, protected by dashboard_status's own RLS policies
--        (dashboard_status_insert/_update, `with check (true)` for any
--        authenticated user — see 20260731000009_open_candidate_status_
--        writes.sql). There is no Edge Function anywhere in this path.
--
-- There is no separate `candidates` table: a candidate's full identity
-- (name, email, resume, etc.) lives entirely in the dashboard's own
-- uploaded HTML in Storage, never in Postgres. dashboard_status is the
-- ONLY place a candidate has a stable database identity at all, and only
-- once they've been "touched" (a status or action set) for the first time
-- — see dashboard_status_candidate_unique (dashboard_id, candidate_name).
-- Its own `id` is therefore the actual existing candidate identifier this
-- schema has to offer; candidate_id below references it directly, never a
-- name or email.
--
-- Given writes reach Postgres directly (no Edge Function to add backend
-- logic to), the trusted server-side layer for this feature is a database
-- trigger — exactly the same pattern already established by
-- dashboard_status_set_audit_fields (20260720000001), which stamps
-- updated_by := auth.uid() on every insert/update of this same table,
-- ignoring whatever (if anything) the client sends. This migration adds a
-- second, independent AFTER trigger that additionally writes an audit row
-- whenever `action` actually changes value — in the SAME statement/
-- transaction as the write itself, which is what makes the action update
-- and the audit log atomically consistent: either both happen (the
-- transaction commits) or neither does (it rolls back). No two-step
-- orchestration, no risk of "action updated but log insert failed" or vice
-- versa.

create table if not exists public.candidate_action_logs (
  id               uuid primary key default gen_random_uuid(),
  -- on delete cascade matches dashboard_status's own convention for its
  -- dashboard_id FK: deleting a dashboard already fully wipes every
  -- dashboard_status row under it (and its Storage HTML), so a dangling
  -- audit log with no candidate/dashboard left to describe would be pure
  -- noise, not preserved history — there is no existing soft-delete or
  -- history-preservation convention for dashboards in this schema to be
  -- consistent with instead.
  dashboard_id     uuid not null references public.dashboards (id) on delete cascade,
  -- References dashboard_status.id, NOT a name/email — see the module
  -- comment above for why that row's own id is this schema's actual
  -- candidate identifier. Same on delete cascade reasoning as dashboard_id.
  candidate_id     uuid not null references public.dashboard_status (id) on delete cascade,
  previous_action  text check (
    previous_action is null or previous_action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense'
    )
  ),
  new_action       text check (
    new_action is null or new_action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense'
    )
  ),
  -- Always the AUTHENTICATED CALLER's own auth.uid(), stamped by the
  -- trigger below — never accepted from the client (see
  -- log_candidate_action_change()). Nullable only so ON DELETE SET NULL
  -- can apply if that profile is later deleted, matching the existing
  -- dashboard_status.updated_by / dashboards.created_by convention —
  -- every row this trigger ever inserts has a real, non-null value.
  changed_by       uuid references public.profiles (id) on delete set null,
  -- Always the DATABASE's own now(), stamped by the trigger below — never
  -- accepted from the client.
  changed_at       timestamptz not null default now()
);

comment on table public.candidate_action_logs is 'Append-only audit trail of candidate Action changes (dashboard_status.action). One row per successful, actual transition — never for a no-op re-selection of the same value, and never for a failed update. Populated only by log_candidate_action_change(), a trigger on dashboard_status; RLS denies every direct client write.';
comment on column public.candidate_action_logs.candidate_id is 'References dashboard_status.id — the only existing stable per-candidate identity in this schema (candidates themselves live in the dashboard''s uploaded HTML, never in Postgres). Never a candidate name or email.';
comment on column public.candidate_action_logs.changed_by is 'The authenticated user who made the change (auth.uid() at the time of the trigger, never client-supplied). Null only if that profile has since been deleted (on delete set null) — the row itself is never deleted for that reason.';
comment on column public.candidate_action_logs.changed_at is 'Server/database timestamp (now()) at the moment of the change — never accepted from the client.';

create index if not exists candidate_action_logs_candidate_id_changed_at_idx
  on public.candidate_action_logs (candidate_id, changed_at);
create index if not exists candidate_action_logs_changed_by_idx
  on public.candidate_action_logs (changed_by);
create index if not exists candidate_action_logs_dashboard_candidate_changed_at_idx
  on public.candidate_action_logs (dashboard_id, candidate_id, changed_at);

alter table public.candidate_action_logs enable row level security;
-- Deliberately NO insert/update/delete policy for any client role: the
-- table is written to exclusively by log_candidate_action_change() below,
-- a security definer trigger function that runs as the table owner and so
-- is unaffected by RLS — an ordinary authenticated (or anon) client has no
-- policy permitting any write here at all, making the table append-only
-- and immutable from the client's perspective by construction. No SELECT
-- policy either for now — reading these logs isn't part of this change;
-- add one deliberately when a real read feature is built, scoped to
-- whatever that feature actually needs.

-- ---------------------------------------------------------------------------
-- log_candidate_action_change(): the trigger that actually creates audit
-- rows. Fires AFTER insert/update on dashboard_status so it never blocks
-- or alters the write it's auditing, and so it runs in the exact same
-- transaction/statement — the source of the atomicity guarantee described
-- in the module comment above.
-- ---------------------------------------------------------------------------
create or replace function public.log_candidate_action_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous text;
begin
  -- No identifiable authenticated caller (e.g. a hypothetical future
  -- service-role/system write) — skip logging rather than fail the write
  -- with a NOT NULL-style violation. Every write this trigger sees today
  -- goes through dashboard_status's own RLS, which already requires `to
  -- authenticated`, so auth.uid() is always present in practice; this is
  -- defensive, not the normal path.
  if auth.uid() is null then
    return new;
  end if;

  -- On INSERT there is no OLD row, so the candidate's previous action is
  -- implicitly NULL — exactly right, since a brand-new dashboard_status
  -- row (however it was created) never had a prior action.
  previous := case when tg_op = 'UPDATE' then old.action else null end;

  -- IS NOT DISTINCT FROM is the NULL-safe equality Postgres provides for
  -- exactly this: previous/new both NULL counts as "no change" (never
  -- logged), and it's what makes re-selecting the SAME action, or a
  -- status-only upsert that never touches `action` at all, correctly
  -- produce no audit row.
  if previous is not distinct from new.action then
    return new;
  end if;

  insert into public.candidate_action_logs (
    dashboard_id, candidate_id, previous_action, new_action, changed_by
  ) values (
    new.dashboard_id, new.id, previous, new.action, auth.uid()
  );

  return new;
end;
$$;

drop trigger if exists dashboard_status_log_action_change on public.dashboard_status;
create trigger dashboard_status_log_action_change
  after insert or update on public.dashboard_status
  for each row execute function public.log_candidate_action_change();
