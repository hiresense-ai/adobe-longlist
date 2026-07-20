-- Optional sample data. Run this AFTER you have:
--   1. Applied the migrations in supabase/migrations/
--   2. Uploaded the sample HTML files (see src/dashboard-templates/) to the
--      "dashboards" storage bucket, under the "dashboards/" folder
--   3. Signed up at least one admin user and promoted them:
--      update public.profiles set role = 'admin' where email = 'you@adobe.com';

insert into public.dashboards (title, description, file_name, storage_path, category, created_by)
select
  v.title,
  v.description,
  v.file_name,
  'dashboards/' || v.file_name,
  v.category,
  (select id from public.profiles where role = 'admin' order by created_at limit 1)
from (
  values
    ('Adobe Dashboard', 'Core Adobe hiring longlist and candidate tracking.', 'Adobe Dashboard.html', 'Adobe'),
    ('Hiring Dashboard', 'Cross-functional hiring pipeline overview.', 'Hiring Dashboard.html', 'Hiring'),
    ('Sales Dashboard', 'Sales team longlist and candidate tracking.', 'Sales Dashboard.html', 'Sales'),
    ('Marketing Dashboard', 'Marketing team longlist and candidate tracking.', 'Marketing Dashboard.html', 'Marketing')
) as v(title, description, file_name, category)
where not exists (
  select 1 from public.dashboards d where d.storage_path = 'dashboards/' || v.file_name
);
