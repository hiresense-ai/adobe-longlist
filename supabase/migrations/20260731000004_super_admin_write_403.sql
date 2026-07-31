-- Adobe Longlist — make unauthorized writes fail LOUDLY with HTTP 403
--
-- Problem this fixes: RLS alone does not produce a 403 for UPDATE/DELETE.
--   - INSERT violating a WITH CHECK policy  -> SQLSTATE 42501 -> HTTP 403 ✅
--   - UPDATE/DELETE whose USING clause matches no rows -> simply affects
--     zero rows -> HTTP 200 with an empty result ❌
-- The data is still fully protected either way (nothing is written), but a
-- caller probing the API receives a misleading "200 OK". Verified against
-- the live API: an Admin's PATCH/DELETE on dashboards and dashboard_status
-- returned 200 while changing nothing.
--
-- Fix: BEFORE ... FOR EACH STATEMENT triggers. A row-level trigger would
-- not help here — it only fires for rows RLS already let through, which is
-- exactly the empty set in the unauthorized case. A statement-level trigger
-- fires regardless of how many rows match, so it can reject the statement
-- itself and raise 42501, which PostgREST maps to 403.
--
-- auth.uid() IS NULL means service_role / migration context (no end-user
-- JWT); those bypass, the same convention the existing guard_profile_*
-- triggers use, so seeds, migrations and Edge Functions are unaffected.
--
-- Defense in depth: the RLS policies from 20260731000002 / 20260731000003
-- stay exactly as they are and remain the actual access control. This only
-- corrects the status code reported for a denied write.

create or replace function public.require_super_admin_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_super_admin() then
    raise exception using
      errcode = '42501',
      message = 'Only a Super Admin can modify ' || tg_table_name || '.';
  end if;
  -- Return value is ignored for BEFORE ... FOR EACH STATEMENT triggers.
  return null;
end;
$$;

drop trigger if exists dashboards_require_super_admin_write on public.dashboards;
create trigger dashboards_require_super_admin_write
  before insert or update or delete on public.dashboards
  for each statement execute function public.require_super_admin_write();

drop trigger if exists dashboard_status_require_super_admin_write on public.dashboard_status;
create trigger dashboard_status_require_super_admin_write
  before insert or update or delete on public.dashboard_status
  for each statement execute function public.require_super_admin_write();
