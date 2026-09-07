-- Adobe Longlist — link two requirements to their JD dashboards.
--
-- Product-owner-confirmed mappings only. Both were verified against live
-- production data (exact ids read back before writing), and each target
-- dashboard was confirmed to still exist:
--
--   requirement 29d1dfb6-cd86-4425-a822-e7d86aa6649d  "Design Manager"
--     -> dashboard f0a80c9d-19ec-44f2-97ed-7a49d7ca7baa  "Design Manager"
--
--   requirement 80f376ab-127a-440a-adc7-cccf474929d8  "Solutions Consultant"
--     -> dashboard 8c5e968b-257e-435e-9a94-f29e28b273b5  "Solutions Consultant "
--        (the dashboard title carries a trailing space; same JD)
--
-- Addressed by PRIMARY KEY, never by title/fuzzy matching — the titles above
-- are documentation, not selection criteria. Deliberately EXCLUDED:
--   * "Machine Learning Engineer 4" — two plausible dashboards ("Machine
--     Learning Engineer" and "… Set 2"); ambiguous, so it stays NULL.
--   * the four Pending requirements — no surviving dashboard.
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
set dashboard_id = 'f0a80c9d-19ec-44f2-97ed-7a49d7ca7baa'
where id = '29d1dfb6-cd86-4425-a822-e7d86aa6649d'
  and dashboard_id is null;

update public.requirements
set dashboard_id = '8c5e968b-257e-435e-9a94-f29e28b273b5'
where id = '80f376ab-127a-440a-adc7-cccf474929d8'
  and dashboard_id is null;
