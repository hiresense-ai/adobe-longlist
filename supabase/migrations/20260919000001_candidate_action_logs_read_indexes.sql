-- Adobe Longlist — read-side indexes for the Super-Admin-only Action Logs
-- page (candidate_action_logs already has candidate_id+changed_at,
-- changed_by, and dashboard_id+candidate_id+changed_at from its own
-- migration, 20260918000001, which cover a single candidate's history and a
-- single candidate-within-a-dashboard's history).
--
-- The Action Logs page's PRIMARY query is different from either of those:
-- every log across every dashboard/candidate, newest first, optionally
-- narrowed to one dashboard (e.g. the "View Action History" entry point
-- from Dashboard Analytics) — never scoped to one candidate. Sorting the
-- full table by changed_at, or one dashboard's slice of it by changed_at,
-- can't use candidate_id-leading indexes as anything but a partial filter,
-- since rows sharing a dashboard_id are ordered by candidate_id first in
-- that index, not changed_at — Postgres would still need an explicit sort.
--
--   changed_at desc                 — the global "every log, newest first"
--                                     query (no dashboard/candidate filter
--                                     applied).
--   (dashboard_id, changed_at desc) — one dashboard's logs, newest first.
--   new_action                      — the Action filter dropdown.
--
-- Not added: a changed_by+changed_at composite (the existing plain
-- changed_by index already narrows to one user cheaply, and per-user log
-- volume is small enough that the resulting sort is negligible) or any
-- index on dashboard_status/dashboards/profiles for the Action Logs
-- search box (candidate name / dashboard title / user name+email) — those
-- are simple ILIKE scans over admin-only, occasional queries, not worth a
-- new index for the current expected scale.
create index if not exists candidate_action_logs_changed_at_idx
  on public.candidate_action_logs (changed_at desc);

create index if not exists candidate_action_logs_dashboard_id_changed_at_idx
  on public.candidate_action_logs (dashboard_id, changed_at desc);

create index if not exists candidate_action_logs_new_action_idx
  on public.candidate_action_logs (new_action);
