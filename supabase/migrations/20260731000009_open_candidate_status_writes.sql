-- Adobe Longlist — open candidate status/action writes back to every
-- authenticated user.
--
-- The ORIGINAL schema (20260720000002_rls_policies.sql) already had this
-- right, with its own comment saying exactly why:
--
--   "dashboard_status — every authenticated user can view and update
--    candidate status (that is the core purpose of the portal)"
--
-- The RBAC work on 2026-07-31 (0690a33 / 20260731000002,
-- 20260731000007) narrowed dashboard_status writes to Super Admin only,
-- alongside the (correct, unrelated, and unchanged by this migration)
-- restriction on managing dashboards themselves — upload / replace /
-- delete. That over-narrowed the candidate-status/action feature along
-- with it. This migration reverts ONLY the dashboard_status write
-- policies and their enforcement trigger back to the original "any
-- authenticated user" model.
--
-- Explicitly NOT touched: public.dashboards (upload/update/delete stays
-- Super Admin only), the `dashboards` storage bucket, profiles/Users
-- management, or any auth/lockout/password-reset logic. Those are
-- separate features gated by separate policies and are unaffected here.

-- ---------------------------------------------------------------------------
-- dashboard_status: revert insert/update to "any authenticated user",
-- matching dashboard_status_select (already `using (true)`, never
-- restricted) and the original schema's own stated intent.
-- ---------------------------------------------------------------------------
drop policy if exists "dashboard_status_insert" on public.dashboard_status;
create policy "dashboard_status_insert"
  on public.dashboard_status for insert
  to authenticated
  with check (true);

drop policy if exists "dashboard_status_update" on public.dashboard_status;
create policy "dashboard_status_update"
  on public.dashboard_status for update
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Drop the require_super_admin_write trigger from dashboard_status only.
--
-- That trigger's whole purpose (20260731000004) is to turn a WRITE THAT RLS
-- SILENTLY DROPS TO ZERO ROWS into an explicit 403, for a table where only
-- Super Admin is allowed to write at all. Now that any authenticated user's
-- insert/update on dashboard_status is genuinely permitted by RLS above,
-- that failure mode can't happen here any more — an allowed caller's write
-- really does affect the row, exactly as a normal insert/update should.
--
-- The identical trigger on public.dashboards (dashboards_require_super_
-- admin_write) is left in place untouched: dashboard upload/replace/delete
-- is still Super Admin only, and still needs that same-statement-transaction
-- 403 for the same reason it always did.
drop trigger if exists dashboard_status_require_super_admin_write
  on public.dashboard_status;
