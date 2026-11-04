-- Which source the contact service used, per kind, on Lyca's row (HIR-537).
--
-- With CONTACT_VENDORS_VIA_SERVICE on, Lyca keeps the service's answer as the person's
-- contact_store row in candidate_contact_lookups. The service says per kind which source
-- answered (`found_in_by_kind`: store, contactout, salesql, bettercontact, ziplabs or none),
-- but Lyca only read it (to know the service ran Lyca's order) and did not keep it, so its
-- own records could not say which vendor a contact came from or reconcile vendor spend.
-- It is now kept here, written on every lookup and Find another answer
-- (supabase/functions/candidate-contacts/via-service.ts): per kind, the source the latest
-- answer for that kind named; a kind not asked keeps what it held. Server-side only: the
-- panel's payload never carries it.
--
-- Additive only: one nullable column. Apply before the functions that read it (scripts/lyca-
-- deploy.mjs refuses functions-deploy while a migration is unapplied).

alter table public.candidate_contact_lookups
  add column if not exists found_in_by_kind jsonb;

comment on column public.candidate_contact_lookups.found_in_by_kind is
  'contact_store rows with CONTACT_VENDORS_VIA_SERVICE on: per kind, the source the contact service''s latest answer for that kind named, e.g. {"email": "salesql", "phone": "none"}. Server-side only, never sent to the browser. Null otherwise.';
