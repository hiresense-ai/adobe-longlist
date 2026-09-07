-- Adobe Longlist — link the "Machine Learning Engineer 4" requirement to its
-- JD dashboard. Product-owner-approved mapping (2026-09-07), verified
-- against live production before writing: the requirement id below exists
-- with dashboard_id NULL, and the dashboard id below exists with the title
-- "Machine Learning Engineer 4".
--
--   requirement 16c1b3dd-97b1-488b-bb2d-547678f80fbb  "Machine Learning Engineer 4"
--     -> dashboard 569a3960-e3d7-4ee8-979e-0542c2e2b2a5  "Machine Learning Engineer 4"
--
-- Addressed by PRIMARY KEY — the titles are documentation, never selection
-- criteria. SCOPE: sets ONE column, dashboard_id, on exactly one row. The
-- `dashboard_id is null` guard makes it idempotent and means an existing
-- link can never be overwritten. It changes no status, created_by,
-- created_at, completed_at, contacted_by or contacted_at; inserts nothing;
-- deletes nothing; touches no dashboard, dashboard_status, candidate,
-- assignment, note or profile row. The FK guarantees the target dashboard
-- exists, and ON DELETE SET NULL clears the link again if that dashboard is
-- ever deleted. Environments without this id: a verified no-op.

update public.requirements
set dashboard_id = '569a3960-e3d7-4ee8-979e-0542c2e2b2a5'
where id = '16c1b3dd-97b1-488b-bb2d-547678f80fbb'
  and dashboard_id is null;
