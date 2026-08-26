-- Adobe Longlist — Requirement detail fields (experience, role type,
-- not-a-fit notes).
--
-- Additive only: four new NULLABLE columns on public.requirements. All
-- pre-existing requirement rows keep working untouched — null here simply
-- means "created before these fields existed", and the UI hides the
-- corresponding sections for such rows rather than inventing values.
-- Requiredness for NEW requirements (all but not_a_fit) is enforced by the
-- requirements Edge Function (the table's only access path — deny-all RLS,
-- see 20260819000001_requirements.sql), exactly like the existing
-- at-least-one-top-skill rule; the DB layer only guards value validity.
--
-- The existing requirement_top_skills table is deliberately NOT renamed:
-- "Must-Have Skills" is a display-label change only, the internal
-- top_skills architecture and every existing row stay as they are.

alter table public.requirements
  add column if not exists relevant_experience numeric,
  add column if not exists total_experience numeric,
  add column if not exists role_type text,
  add column if not exists not_a_fit text;

comment on column public.requirements.relevant_experience is 'Minimum role-relevant experience in years (decimals allowed). Null only on rows created before this column existed.';
comment on column public.requirements.total_experience is 'Total experience in years (decimals allowed); >= relevant_experience. Null only on rows created before this column existed.';
comment on column public.requirements.role_type is 'ic | manager. Null only on rows created before this column existed.';
comment on column public.requirements.not_a_fit is 'Optional recruiter notes on what is NOT required / would make a candidate unsuitable.';

alter table public.requirements
  add constraint requirements_relevant_experience_range check (
    relevant_experience is null
    or (relevant_experience >= 0 and relevant_experience <= 99)
  ),
  add constraint requirements_total_experience_range check (
    total_experience is null
    or (total_experience >= 0 and total_experience <= 99)
  ),
  -- Total must never be lower than relevant when both are present — the
  -- Edge Function rejects this first with a friendly message; this is the
  -- backstop.
  add constraint requirements_experience_consistent check (
    relevant_experience is null
    or total_experience is null
    or total_experience >= relevant_experience
  ),
  -- Exactly the two role types, stored as stable lowercase values — the
  -- display labels ("IC (Individual Contributor)" / "Manager") live in the
  -- frontend only.
  add constraint requirements_role_type_check check (
    role_type is null or role_type in ('ic', 'manager')
  ),
  add constraint requirements_not_a_fit_length check (
    not_a_fit is null or char_length(not_a_fit) <= 2000
  );
