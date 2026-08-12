-- ---------------------------------------------------------------------------
-- LOCAL-ONLY environment bootstrap. This file is applied exclusively by the
-- local stack (`supabase start` / `supabase db reset`) — `db push` never
-- runs it, so nothing here can ever reach production.
--
-- Why it exists: the production project (created 2026-07-20) has Supabase's
-- older default privileges, where tables/functions created via migrations
-- automatically receive DML/EXECUTE grants for the API roles (anon,
-- authenticated, service_role). The current local Postgres image ships a
-- stricter baseline (API roles get no DML on new public tables and no
-- EXECUTE on new public functions), so the same migrations produce a local
-- database the app can't talk to. The statements below replicate the grant
-- state production actually has — they change nothing about the app's
-- security model, which is enforced by RLS, not by these coarse grants.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on all tables in schema public
  to anon, authenticated, service_role;

grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

grant execute on all functions in schema public
  to anon, authenticated, service_role;

-- Future tables/functions created by later local migrations should get the
-- same treatment automatically, mirroring production's behavior.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

-- Re-assert the ONE deliberate exception: migration
-- 20260731000008_atomic_failed_login_counter.sql revokes
-- register_failed_login from the browser-facing roles (it is service-role
-- only). The blanket function grant above would have re-opened it locally,
-- so re-apply the migration's exact revokes here.
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from public;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from anon;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from authenticated;
grant execute on function public.register_failed_login(uuid, integer, integer, boolean) to service_role;
