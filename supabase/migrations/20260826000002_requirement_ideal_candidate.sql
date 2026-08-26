-- Adobe Longlist — Requirement "Ideal Candidate" field.
--
-- Additive only: one new NULLABLE text column on public.requirements, the
-- exact same shape and access model as not_a_fit (see
-- 20260826000001_requirement_details.sql) — optional free text, null on
-- rows created before the column existed, served/edited exclusively
-- through the requirements Edge Function (deny-all RLS), and stripped
-- from a Viewer's post-Contacted responses along with the rest of the
-- full-detail shape.

alter table public.requirements
  add column if not exists ideal_candidate text;

comment on column public.requirements.ideal_candidate is 'Optional free-text description of the ideal candidate profile for this requirement.';

alter table public.requirements
  add constraint requirements_ideal_candidate_length check (
    ideal_candidate is null or char_length(ideal_candidate) <= 2000
  );
