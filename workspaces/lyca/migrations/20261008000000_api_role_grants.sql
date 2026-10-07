-- LYCA MOBILE ONLY. Table/sequence/function privileges for the Data API
-- roles, matching what Adobe's production project has from its older
-- baseline (and what supabase/seed.sql replicates locally). Newer Supabase
-- projects no longer grant these automatically; without them every API call
-- fails with "permission denied". Row Level Security still decides which
-- rows each caller may see. Ordered before the Lyca security migration so
-- that migration's explicit revokes win.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;
grant execute on all functions in schema public
  to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

-- The failed-login counter is server-only (auth-login Edge Function), exactly
-- as in supabase/seed.sql.
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from public;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from anon;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from authenticated;
grant execute on function public.register_failed_login(uuid, integer, integer, boolean) to service_role;
