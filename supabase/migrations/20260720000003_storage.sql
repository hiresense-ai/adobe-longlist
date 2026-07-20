-- Adobe Longlist — Storage bucket + policies for HTML dashboard files.
-- The bucket is private: files are only readable by authenticated users,
-- and only writable by admins. The app downloads HTML via the client SDK
-- (which forwards the user's session), never via public URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dashboards', 'dashboards', false, 26214400, array['text/html', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "dashboards_bucket_select" on storage.objects;
create policy "dashboards_bucket_select"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'dashboards');

drop policy if exists "dashboards_bucket_insert_admin" on storage.objects;
create policy "dashboards_bucket_insert_admin"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'dashboards' and public.is_admin());

drop policy if exists "dashboards_bucket_update_admin" on storage.objects;
create policy "dashboards_bucket_update_admin"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'dashboards' and public.is_admin())
  with check (bucket_id = 'dashboards' and public.is_admin());

drop policy if exists "dashboards_bucket_delete_admin" on storage.objects;
create policy "dashboards_bucket_delete_admin"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'dashboards' and public.is_admin());
