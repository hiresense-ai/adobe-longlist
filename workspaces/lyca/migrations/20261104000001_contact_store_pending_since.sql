-- When the contact service's "still fetching" began, in its own column (HIR-537 review).
--
-- With CONTACT_VENDORS_VIA_SERVICE on, Lyca keeps the service's answer as the person's
-- contact_store row in candidate_contact_lookups. While the service answers a kind as `pending`
-- (ZipLabs still fetching), the panel re-checks it for at most 60 s from when that began
-- (supabase/functions/candidate-contacts/via-service.ts). That time was kept in
-- vendor_request_id as "pending_since=<time>", a column that means a vendor's request id
-- elsewhere (the BetterContact poll reads it). It now has its own column; nothing is ever
-- written to vendor_request_id for this purpose. No row holds the old form: HIR-537 was never
-- deployed.
--
-- Additive only: one nullable column. Apply before the functions that read it (scripts/lyca-
-- deploy.mjs refuses functions-deploy while a migration is unapplied).

alter table public.candidate_contact_lookups
  add column if not exists pending_since timestamptz;

comment on column public.candidate_contact_lookups.pending_since is
  'contact_store rows with CONTACT_VENDORS_VIA_SERVICE on: when the contact service began answering a kind as pending (the panel re-checks for 60 s from then). Null otherwise.';
