-- Adobe Longlist — backfill completed_at for requirements that were
-- already 'Completed' before the column existed.
--
-- Product decision (2026-09-04): existing Completed requirements need a
-- Completed Date. Where the audit trail recorded the actual transition,
-- use THAT timestamp; where history is untraceable, use the date this
-- migration runs ("today"), and from then on the requirements Edge
-- Function stamps every new transition into 'Completed' automatically.
--
-- Two passes, both scoped strictly to `status = 'Completed' AND
-- completed_at IS NULL` — rows the Edge Function already stamped are
-- never touched, and the migration is idempotent (a re-run finds nothing
-- left to fill):
--
--   1. Best-effort audit recovery. The requirements Edge Function logs a
--      'requirement.status_changed' audit event with metadata.to on every
--      transition. When such an event into 'Completed' exists for a row,
--      its created_at IS the real transition moment — audit inserts are
--      best-effort (an insert failure is only console-logged), so events
--      can be MISSING, but an existing event is never wrong. The LATEST
--      such event is used, matching the live stamping rule (a reopened and
--      re-completed requirement carries its newest completion time).
--
--   2. Fallback for everything still NULL: now() — the explicitly chosen
--      "put today's date" rule, never a guess dressed up as history
--      (updated_at/contacted_at deliberately not used; they mean other
--      things).

update public.requirements r
set completed_at = audit.latest_completed
from (
  select
    target_id,
    max(created_at) as latest_completed
  from public.audit_logs
  where action = 'requirement.status_changed'
    and metadata ->> 'to' = 'Completed'
  group by target_id
) audit
where r.status = 'Completed'
  and r.completed_at is null
  and audit.target_id = r.id::text;

update public.requirements
set completed_at = now()
where status = 'Completed'
  and completed_at is null;
