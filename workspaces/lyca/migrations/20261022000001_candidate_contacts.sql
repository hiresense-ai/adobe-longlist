-- Candidate contact lookup (email + phone) through external vendors.
--
-- Lyca only. Flow (supabase/functions/candidate-contacts): "Get contact"
-- asks SalesQL. BetterContact is the backup and only ever runs when someone
-- clicks for it — per kind ("Find phone number" / "Find another email"),
-- offered when SalesQL found none of that kind or one was marked 👎. Every
-- vendor answer is cached here per LinkedIn profile, so the same person is
-- never paid for twice (even across dashboards). Vendor names are internal:
-- the UI never shows them.
--
-- Both tables hold personal contact data, so neither has ANY client RLS
-- policy: browsers never read or write them directly. All access goes
-- through the candidate-contacts Edge Function, which verifies the caller's
-- session, role and dashboard visibility first and then uses the service
-- role — the same "verified identity first" shape as action-logs.

create table if not exists public.candidate_contact_lookups (
  id                uuid primary key default gen_random_uuid(),
  -- Normalized profile key, e.g. "linkedin.com/in/jane-doe" (lowercase, no
  -- protocol/www/query/trailing slash) — the cache identity.
  linkedin_key      text not null,
  linkedin_url      text not null,
  vendor            text not null,
  status            text not null,
  -- [{ "value": "...", "type": "Work"|"Direct"|..., "status": "Valid"|... }]
  emails            jsonb not null default '[]'::jsonb,
  -- [{ "value": "+91...", "type": "Mobile"|..., "valid": true|null }]
  phones            jsonb not null default '[]'::jsonb,
  -- BetterContact is asynchronous: its request id while still processing.
  vendor_request_id text,
  -- Backup searches are per kind, only on request: which kinds this vendor
  -- has already been asked for (never bought twice), and which kinds the
  -- in-flight request covers.
  email_searched    boolean not null default false,
  phone_searched    boolean not null default false,
  pending_kinds     text[],
  error             text,
  credits_used      numeric,
  dashboard_id      uuid references public.dashboards (id) on delete set null,
  candidate_name    text,
  requested_by      uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint candidate_contact_lookups_vendor check (vendor in ('salesql', 'bettercontact')),
  constraint candidate_contact_lookups_status check (status in ('found', 'not_found', 'pending', 'error')),
  constraint candidate_contact_lookups_unique unique (linkedin_key, vendor),
  constraint candidate_contact_lookups_key_length check (char_length(linkedin_key) <= 300)
);

comment on table public.candidate_contact_lookups is
  'Cached contact-vendor answers (SalesQL first, BetterContact backup) per LinkedIn profile. Service-role only — read/written by the candidate-contacts Edge Function.';

create index if not exists candidate_contact_lookups_requested_by_idx
  on public.candidate_contact_lookups (requested_by, created_at desc);

create table if not exists public.candidate_contact_feedback (
  id             uuid primary key default gen_random_uuid(),
  linkedin_key   text not null,
  contact_kind   text not null,
  contact_value  text not null,
  vendor         text not null,
  verdict        text not null,
  reason         text,
  dashboard_id   uuid references public.dashboards (id) on delete set null,
  candidate_name text,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  constraint candidate_contact_feedback_kind check (contact_kind in ('email', 'phone')),
  constraint candidate_contact_feedback_vendor check (vendor in ('salesql', 'bettercontact')),
  constraint candidate_contact_feedback_verdict check (verdict in ('good', 'bad')),
  constraint candidate_contact_feedback_reason check (
    reason is null or reason in ('bounced', 'wrong_person', 'not_reachable', 'no_answer')
  ),
  -- One current verdict per contact value; a later click replaces it.
  constraint candidate_contact_feedback_unique unique (linkedin_key, contact_kind, contact_value)
);

comment on table public.candidate_contact_feedback is
  'Thumbs up / down (with reason) on a looked-up email or phone. A thumbs down unlocks the backup vendor. Service-role only — written by the candidate-contacts Edge Function.';

alter table public.candidate_contact_lookups enable row level security;
alter table public.candidate_contact_feedback enable row level security;

revoke all on public.candidate_contact_lookups from anon, authenticated;
revoke all on public.candidate_contact_feedback from anon, authenticated;
