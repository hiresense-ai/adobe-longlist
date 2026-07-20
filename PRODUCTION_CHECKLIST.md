# Production Checklist

## Supabase

- [ ] Migrations applied in order (`20260720000001_init_schema.sql`, `...002_rls_policies.sql`, `...003_storage.sql`)
- [ ] RLS is **enabled** on `profiles`, `dashboards`, `dashboard_status` (the migrations do this — verify in **Database → Tables** that each shows "RLS enabled")
- [ ] `dashboards` storage bucket exists and is **private** (`public: false`)
- [ ] At least one user promoted to `role = 'admin'` in `public.profiles`
- [ ] Realtime enabled for `dashboard_status` (**Database → Replication**, or confirm via `select * from pg_publication_tables where tablename = 'dashboard_status'`)
- [ ] Auth email templates (confirmation, magic link, reset password) reviewed/branded in **Authentication → Email Templates**
- [ ] Site URL and Redirect URLs (**Authentication → URL Configuration**) include your production domain, e.g. `https://adobe-longlist.hiresense.ai/reset-password`
- [ ] Point-in-time backups / daily backups enabled for the project (Supabase dashboard → Database → Backups) if on a paid plan

## Storage

- [ ] Sample or real dashboard HTML files uploaded under `dashboards/`
- [ ] Corresponding rows exist in `public.dashboards` with matching `storage_path`
- [ ] File size limit (25 MB) and allowed MIME types in the storage migration match your actual files

## Frontend / Vercel

- [ ] `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set for Production, Preview, and Development environments in Vercel
- [ ] `npm run build` passes locally with no TypeScript errors
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] Custom domain (`adobe-longlist.hiresense.ai`) configured and HTTPS certificate issued
- [ ] `vercel.json` SPA rewrite verified: refreshing a deep link (e.g. `/dashboards/<id>`) does not 404
- [ ] Security headers present on responses (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` — configured in `vercel.json`)

## Application behavior

- [ ] Sign up / sign in / sign out work end-to-end against the production Supabase project
- [ ] Forgot password → reset password flow works with the production redirect URL
- [ ] Dashboard list loads, search filters instantly, empty/error states render correctly
- [ ] Opening a dashboard renders the HTML safely inside the sandboxed iframe; fullscreen toggle works
- [ ] Changing a candidate's status saves, shows a success toast, and persists after reload
- [ ] A second browser/tab viewing the same dashboard receives the status update live (Realtime)
- [ ] Non-admin (`viewer`) accounts cannot insert/update/delete rows in `dashboards` (verify via the RLS policies, e.g. attempt an insert from the browser console and confirm it's rejected)
- [ ] Dark mode toggle persists across reloads and respects system preference by default
- [ ] Responsive check on mobile, tablet, and desktop breakpoints
- [ ] 404 page renders for unknown routes; the route-level error boundary renders for unexpected runtime errors

## Housekeeping

- [ ] `.env.local` is not committed (confirmed via `.gitignore`)
- [ ] No secrets in the repository history
- [ ] README reviewed and up to date with the actual deployed URLs
