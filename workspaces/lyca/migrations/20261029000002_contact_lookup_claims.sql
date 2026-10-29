-- One paid vendor call per person and vendor at a time (HIR-528).
--
-- Two recruiters, two tabs or a double click revealing the same person used to both pay SalesQL /
-- BetterContact. Before paying, candidate-contacts now claims (linkedin_key, vendor) here with an
-- insert that does nothing when the row exists, so exactly one request wins and pays; the others
-- wait for its saved answer (supabase/functions/candidate-contacts/claims.ts). The winner deletes
-- its row when done. A row older than a few minutes was left by a request that died and may be
-- taken over.
--
-- Additive only: one new, normally empty table. Service role only, like the contact tables.

create table if not exists public.candidate_contact_claims (
  linkedin_key text not null,
  vendor       text not null,
  claim_id     uuid not null,
  claimed_at   timestamptz not null default now(),
  constraint candidate_contact_claims_pkey primary key (linkedin_key, vendor),
  constraint candidate_contact_claims_vendor check (vendor in ('salesql', 'bettercontact'))
);

comment on table public.candidate_contact_claims is
  'A paid vendor call in progress for one person (HIR-528): at most one per person and vendor. Service-role only — written by the candidate-contacts Edge Function.';

alter table public.candidate_contact_claims enable row level security;
revoke all on public.candidate_contact_claims from anon, authenticated;
grant select, insert, update, delete on public.candidate_contact_claims to service_role;
