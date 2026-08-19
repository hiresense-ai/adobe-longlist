-- Adobe Longlist — Requirement skills & target companies.
--
-- Additive only: three normalized child tables under public.requirements
-- (see 20260819000001_requirements.sql), one row per value rather than a
-- comma-joined string, so future search/filter by skill or company is a
-- plain indexed query instead of a LIKE over concatenated text.
--
-- ACCESS MODEL — identical to the parent table, for the same reason:
-- RLS enabled with NO client policies. Every read and write goes through
-- the `requirements` Edge Function (service role), which already shapes
-- responses per role/status — a Viewer's post-Contacted requirement omits
-- these lists exactly like it omits jd_text/jd_url. Giving the child
-- tables any direct client policy would open a second path around that
-- shaping, so they get none.
--
-- All three tables share the same shape:
--   - requirement_id FK with ON DELETE CASCADE — deleting a requirement
--     can never leave orphan skill/company rows.
--   - position — preserves the order the user entered the chips in; the
--     Edge Function writes lists wholesale and reads them back ordered.
--   - unique (requirement_id, lower(value)) — duplicates within one
--     requirement's list are impossible at the DB layer too, matching the
--     case-insensitive dedupe the Edge Function performs.

create table if not exists public.requirement_top_skills (
  id             uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements (id) on delete cascade,
  skill          text not null,
  position       integer not null default 0,

  constraint requirement_top_skills_skill_length check (
    char_length(skill) between 1 and 100
  )
);

create table if not exists public.requirement_optional_skills (
  id             uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements (id) on delete cascade,
  skill          text not null,
  position       integer not null default 0,

  constraint requirement_optional_skills_skill_length check (
    char_length(skill) between 1 and 100
  )
);

create table if not exists public.requirement_target_companies (
  id             uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements (id) on delete cascade,
  company        text not null,
  position       integer not null default 0,

  constraint requirement_target_companies_company_length check (
    char_length(company) between 1 and 100
  )
);

comment on table public.requirement_top_skills is 'Required skills for a requirement (at least one enforced by the requirements Edge Function). Edge-Function-only access — deny-all RLS, same as public.requirements.';
comment on table public.requirement_optional_skills is 'Nice-to-have skills for a requirement (may be empty). Edge-Function-only access — deny-all RLS, same as public.requirements.';
comment on table public.requirement_target_companies is 'Companies to target for a requirement (may be empty). Edge-Function-only access — deny-all RLS, same as public.requirements.';

create index if not exists requirement_top_skills_requirement_idx
  on public.requirement_top_skills (requirement_id);
create index if not exists requirement_optional_skills_requirement_idx
  on public.requirement_optional_skills (requirement_id);
create index if not exists requirement_target_companies_requirement_idx
  on public.requirement_target_companies (requirement_id);

-- Future search-by-skill/company support (spec'd for later, structured
-- for now): a lower(value) index makes case-insensitive lookups cheap.
create index if not exists requirement_top_skills_skill_idx
  on public.requirement_top_skills (lower(skill));
create index if not exists requirement_optional_skills_skill_idx
  on public.requirement_optional_skills (lower(skill));
create index if not exists requirement_target_companies_company_idx
  on public.requirement_target_companies (lower(company));

create unique index if not exists requirement_top_skills_unique
  on public.requirement_top_skills (requirement_id, lower(skill));
create unique index if not exists requirement_optional_skills_unique
  on public.requirement_optional_skills (requirement_id, lower(skill));
create unique index if not exists requirement_target_companies_unique
  on public.requirement_target_companies (requirement_id, lower(company));

-- Deny-all for clients: enabled RLS + zero policies (see header comment).
alter table public.requirement_top_skills enable row level security;
alter table public.requirement_optional_skills enable row level security;
alter table public.requirement_target_companies enable row level security;
