-- Adobe Longlist — Realtime for the Users page
--
-- The admin Users list subscribes to public.profiles so that a change made
-- anywhere else (another admin's tab, or a delete performed straight from
-- the Supabase Dashboard, which cascades to profiles) invalidates the list
-- while the page is sitting open. Without membership in the
-- supabase_realtime publication that subscription silently never fires —
-- it connects fine and simply receives nothing, which is the worst kind of
-- broken.
--
-- Scope note: this only publishes CHANGE EVENTS. Row visibility still goes
-- through the profiles_select RLS policy, so an Admin subscriber never
-- receives Super Admin rows — the same restriction the REST read already
-- enforces. The client also only uses the event as a signal to refetch
-- through the admin-users Edge Function; it never renders the payload.
--
-- Realtime remains best-effort rather than the correctness guarantee: a
-- GoTrue SOFT delete never touches profiles at all, so it emits nothing.
-- Deleted accounts are kept out of the list by the reconciliation in
-- admin-users' listUsers; this publication only shortens how long a stale
-- page waits before asking again.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
