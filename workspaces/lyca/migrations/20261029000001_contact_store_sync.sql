-- Every revealed contact and every thumbs up / down reaches the shared contact store (HIR-526).
--
-- candidate-contacts sends each lookup answer and each 👍/👎 to the store in the background right
-- after saving it. Until now a failed send (store down) was only logged and lost. From now on each
-- row records whether the store has it:
--
--   store_synced_at null   the store may not hold this version of the row yet. Every insert or
--                          upsert of a row sets it back to null (supabase/functions/candidate-
--                          contacts/store-sync.ts, upsertUnsynced).
--   store_synced_at set    the store took this version, or the row has nothing to send.
--
-- The background send marks the row when it lands, only while the row is unchanged (same id and
-- updated_at). The contact-store-sync Edge Function, run every 10 minutes by a pg_cron job that is
-- set up outside the migrations (the project URL and secret must not be in git), sends whatever is
-- still null, oldest first. Existing rows start null, so the first runs catch them up.
--
-- Additive only: two nullable columns and two partial indexes. Nothing existing is changed; the
-- tables stay service-role only (no client RLS policy).

alter table public.candidate_contact_lookups
  add column if not exists store_synced_at timestamptz;

alter table public.candidate_contact_feedback
  add column if not exists store_synced_at timestamptz;

comment on column public.candidate_contact_lookups.store_synced_at is
  'When the shared contact store took this version of the row (null: not yet, the contact-store-sync job sends it). Reset to null on every write.';

comment on column public.candidate_contact_feedback.store_synced_at is
  'When the shared contact store took this 👍/👎 (null: not yet, the contact-store-sync job sends it). Reset to null on every write.';

-- The job reads only unsynced rows, oldest first.
create index if not exists candidate_contact_lookups_store_unsynced_idx
  on public.candidate_contact_lookups (updated_at)
  where store_synced_at is null;

create index if not exists candidate_contact_feedback_store_unsynced_idx
  on public.candidate_contact_feedback (updated_at)
  where store_synced_at is null;
