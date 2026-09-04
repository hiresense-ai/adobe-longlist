-- Adobe Longlist — backfill completed_at for requirements that were already
-- 'Completed' before the column existed.
--
-- A NEW migration rather than an edit of 20260904000003: that version was
-- released as a deliberate no-op and is already recorded as applied in
-- production, so changing its body would never re-run. This is not a
-- duplicate of it — it is the narrowly-scoped backfill, with different
-- semantics (see below).
--
-- SCOPE — exactly one UPDATE, and it can only ever touch rows where BOTH:
--     status = 'Completed'
--     AND completed_at IS NULL
-- so an existing completed_at can never be overwritten, and no row in any
-- other state is considered. It sets ONE column. It does not change status,
-- created_at, contacted_by, contacted_at, or any other field; it inserts
-- nothing and deletes nothing; it touches no dashboard, candidate, action,
-- note, profile, or assignment row.
--
-- VALUE — the REAL historical completion moment, recovered from the audit
-- trail: the requirements Edge Function writes a 'requirement.status_changed'
-- audit event with metadata->>'to' = 'Completed' on every transition, and
-- that event's created_at IS when the transition happened. The latest such
-- event wins, matching the live stamping rule (a reopened-and-re-completed
-- requirement carries its newest completion time).
--
-- Deliberately NO now()/today fallback: a requirement with no audit event
-- has no knowable completion date, so it keeps NULL and continues to render
-- as an em dash. Completion dates are never invented.
--
-- Idempotent: re-running finds nothing left with a NULL completed_at among
-- audit-covered rows.

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
