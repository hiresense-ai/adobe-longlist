-- Adobe Longlist — requirement completion timestamp.
--
-- Additive only: one nullable column on public.requirements. Stamped
-- EXCLUSIVELY by the requirements Edge Function's updateStatus flow at the
-- moment a requirement actually transitions INTO 'Completed' (the
-- function's same-status early return means a no-op "update" can never
-- re-stamp it). Deliberately NOT backfilled: rows completed before this
-- column existed have no reliable historical completion timestamp
-- (audit_logs inserts are best-effort, contacted_at/updated_at mean other
-- things), so they stay NULL and the UI shows "—" rather than a guessed
-- date. Same convention as contacted_at: a lifecycle timestamp owned by
-- the Edge Function, never written by clients (deny-all RLS on this table
-- already guarantees there is no other write path).

alter table public.requirements
  add column if not exists completed_at timestamptz;

comment on column public.requirements.completed_at is
  'When the requirement last transitioned into status ''Completed'' — set by the requirements Edge Function only; NULL for rows completed before this column existed (never backfilled).';
