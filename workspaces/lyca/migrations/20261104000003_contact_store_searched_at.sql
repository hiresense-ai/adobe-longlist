-- When the contact service's "every source was asked, nothing found" began, per kind (HIR-537 review).
--
-- With CONTACT_VENDORS_VIA_SERVICE on, Lyca keeps the service's answer as the person's
-- contact_store row in candidate_contact_lookups. email_searched / phone_searched on that row mean
-- every source of Lyca's order was asked for the kind and none had it: the panel shows "No email /
-- number found" with no button, and with the setting off the kind is not bought from SalesQL or
-- BetterContact again. The service can answer that way wrongly while it skips a vendor at its
-- cap, switched off or without a key (contact-enrichment #20), so the flag now stands for 30 days
-- only (SERVICE_SEARCHED_MAX_AGE_MS in supabase/functions/candidate-contacts/flow.ts, the service's
-- own recheck period); after that the kind can be asked again. These columns hold when it was set.
-- A flag with no time (none exist: HIR-537 was never deployed) still counts.
--
-- Additive only: two nullable columns. Apply before the functions that read them (scripts/lyca-
-- deploy.mjs refuses functions-deploy while a migration is unapplied; the functions also read
-- without them, with a warning, if they ever meet a database without them).

alter table public.candidate_contact_lookups
  add column if not exists email_searched_at timestamptz,
  add column if not exists phone_searched_at timestamptz;

comment on column public.candidate_contact_lookups.email_searched_at is
  'contact_store rows with CONTACT_VENDORS_VIA_SERVICE on: when email_searched was set (every source asked, none had an email). The flag counts for 30 days from then. Null otherwise.';

comment on column public.candidate_contact_lookups.phone_searched_at is
  'contact_store rows with CONTACT_VENDORS_VIA_SERVICE on: when phone_searched was set (every source asked, none had a phone). The flag counts for 30 days from then. Null otherwise.';
