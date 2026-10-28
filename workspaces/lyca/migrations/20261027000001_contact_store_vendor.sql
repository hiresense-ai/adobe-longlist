-- The shared contact store (hiresense-ai/contact-enrichment) becomes a contact source.
--
-- "Get contact" now asks the store first (contacts any HireSense platform already revealed, then
-- ZipLabs); only when it has nothing does SalesQL run, as before. Its answer is cached here like a
-- vendor's, under vendor = 'contact_store', and a thumbs up / down on such a value is recorded the
-- same way. Nothing else changes: existing rows, the backup flow and the dashboard are untouched.

alter table public.candidate_contact_lookups
  drop constraint if exists candidate_contact_lookups_vendor;
alter table public.candidate_contact_lookups
  add constraint candidate_contact_lookups_vendor
  check (vendor in ('salesql', 'bettercontact', 'contact_store'));

alter table public.candidate_contact_feedback
  drop constraint if exists candidate_contact_feedback_vendor;
alter table public.candidate_contact_feedback
  add constraint candidate_contact_feedback_vendor
  check (vendor in ('salesql', 'bettercontact', 'contact_store'));
