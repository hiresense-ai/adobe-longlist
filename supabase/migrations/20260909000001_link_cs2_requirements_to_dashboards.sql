-- Adobe Longlist — link two requirements to their JD dashboards.
--
-- Product-owner-approved mappings only (2026-09-09), verified against live
-- production immediately before this migration was applied: both target
-- dashboards exist and both requirement ids had dashboard_id NULL.
--
--   requirement 4c8e83e8-bb11-4d76-ad19-8a8611d80e99  "Computer Scientist 2 ( Full Stack Frontend Heavy )"
--     -> dashboard 3e6c7b58-577a-431f-8b7a-89abbc24adfa  "Computer Scientist 2 ( Full Stack Frontend Heavy )"
--
--   requirement 6b3e46e3-76a9-4101-9926-a44d45b5c0b2  "CS2 : Nodejs"
--     -> dashboard 4d34166b-3129-4110-ab6b-5cfbcc12d43d  "CS2 : Nodejs"
--
-- Addressed by PRIMARY KEY, never by title/fuzzy matching — the titles
-- above are documentation, not selection criteria.
--
-- SCOPE: sets ONE column, dashboard_id, on exactly two rows. The
-- `dashboard_id is null` guard makes it idempotent and means an existing
-- link can never be overwritten. It changes no status, created_by,
-- created_at, completed_at, contacted_by or contacted_at; it inserts
-- nothing and deletes nothing; it touches no dashboard, dashboard_status,
-- candidate, assignment, note or profile row. The FK itself guarantees the
-- target dashboard exists, and ON DELETE SET NULL means a future dashboard
-- deletion simply clears the link again.
--
-- Environments other than production do not hold these ids, where it is a
-- verified no-op.

update public.requirements
set dashboard_id = '3e6c7b58-577a-431f-8b7a-89abbc24adfa'
where id = '4c8e83e8-bb11-4d76-ad19-8a8611d80e99'
  and dashboard_id is null;

update public.requirements
set dashboard_id = '4d34166b-3129-4110-ab6b-5cfbcc12d43d'
where id = '6b3e46e3-76a9-4101-9926-a44d45b5c0b2'
  and dashboard_id is null;
