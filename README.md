# Adobe Longlist

A secure internal dashboard portal. Authenticated users sign in, browse HTML hiring dashboards, open one, and update candidate status live — every change is saved to Supabase instantly and synced to anyone else viewing the same dashboard.

## Table of contents

- [Project overview](#project-overview)
- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Supabase setup](#supabase-setup)
- [Storage setup](#storage-setup)
- [Authentication](#authentication)
- [Running locally](#running-locally)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Production checklist](#production-checklist)

## Project overview

| | |
|---|---|
| Frontend | React 19, TypeScript, Vite, React Router v7, Tailwind CSS v4, shadcn/ui, TanStack Query, React Hook Form, Zod |
| Backend | Supabase (Postgres, Auth, Storage, Row Level Security, Realtime) |
| Deployment | Vercel (frontend) + Supabase (backend) |

**Flow:** Login → Dashboard Home (search + cards) → open a dashboard → the HTML file is rendered in a sandboxed iframe → changing a candidate's status dropdown saves to Supabase instantly → a toast confirms the save → the change syncs in real time to any other open viewer.

## Architecture

```
┌────────────┐     Supabase Auth      ┌──────────────────┐
│   Browser  │ ───────────────────►   │  Supabase Project │
│ (React app)│                        │                    │
│            │  REST (RLS-enforced)  │  - Postgres        │
│            │ ───────────────────►  │  - Storage         │
│            │                        │  - Realtime        │
│            │ ◄─────────────────────│  - Auth            │
└─────┬──────┘   Realtime (WS)        └──────────────────┘
      │
      │ renders inside a sandboxed <iframe> (blob: URL)
      ▼
┌────────────────────┐   postMessage    ┌──────────────────┐
│ Static HTML         │ ───────────────► │ Host React app    │
│ dashboard (Storage) │ ◄─────────────── │ (writes to        │
│                     │   ack / init     │  Supabase, shows  │
└────────────────────┘   statuses        │  toast)           │
                                          └──────────────────┘
```

Dashboards are plain, framework-free HTML files stored in a private Supabase Storage bucket. They never talk to Supabase directly — instead, the host app downloads the HTML, injects a small bootstrap script (`src/lib/dashboardBridge.ts`), and renders it in a sandboxed iframe. That script wires up any element marked `data-longlist-status` to `postMessage` the host whenever it changes; the host performs the actual Supabase write, RLS included, using the signed-in user's session. This keeps every dashboard file simple and static while still getting authenticated, audited writes.

## Folder structure

```
adobe-longlist/
├── dashboard-templates/       Sample static HTML dashboards (upload these to Storage)
├── supabase/
│   ├── migrations/            SQL: schema, RLS policies, storage policies
│   └── seed/                  Optional sample data
├── src/
│   ├── api/                   Axios instance for any non-Supabase HTTP calls
│   ├── assets/
│   ├── components/
│   │   ├── ui/                 shadcn/ui primitives
│   │   ├── layout/              Navbar, AppLayout
│   │   ├── common/               EmptyState, ErrorState, ThemeToggle, RouteErrorBoundary
│   │   ├── dashboard/            DashboardCard, DashboardFrame, skeletons
│   │   └── auth/                 ProtectedRoute, GuestRoute
│   ├── constants/               Status options, routes, query keys
│   ├── context/                  AuthContext / auth-context
│   ├── hooks/                   useAuth, useDashboards, useDashboardStatusBridge, ...
│   ├── lib/                      cn(), errors, format, queryClient, dashboardBridge
│   ├── pages/
│   │   ├── Login/                Login, ForgotPassword, ResetPassword
│   │   ├── Dashboard/             Dashboard home (grid + search)
│   │   ├── DashboardViewer/       Iframe viewer
│   │   ├── Profile/
│   │   └── NotFound/
│   ├── routes/                  React Router route tree
│   ├── services/                 dashboards.service, dashboardStatus.service
│   ├── supabase/                  client, auth, storage, database helpers
│   └── types/                    Database + app types
├── .env.example
├── vercel.json
└── package.json
```

## Installation

```bash
git clone https://github.com/hiresense-ai/adobe-longlist.git
cd adobe-longlist
npm install
```

Requires Node.js 20+.

## Environment variables

Copy `.env.example` to `.env.local` and fill in your Supabase project's values (**Project Settings → API** in the Supabase dashboard):

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon/public key — safe to expose client-side, access is enforced by RLS |

`.env.local` is git-ignored. Never commit real keys.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run the migrations **in order**:
   - `supabase/migrations/20260720000001_init_schema.sql` — tables, triggers, the `is_admin()` helper, and Realtime publication for `dashboard_status`.
   - `supabase/migrations/20260720000002_rls_policies.sql` — Row Level Security policies.
   - `supabase/migrations/20260720000003_storage.sql` — creates the `dashboards` storage bucket + its policies.
3. Sign up your first user from the app's Login page (or via **Authentication → Users** in the dashboard), then promote them to admin:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@adobe.com';
   ```
   Admins can upload/manage dashboards; every authenticated user (admin or viewer) can update candidate status.
4. (Optional) Run `supabase/seed/seed.sql` after uploading the sample dashboards below to pre-populate the dashboard list.

If you use the Supabase CLI instead of the SQL editor, the migration filenames already follow its naming convention — `supabase db push` will pick them up as-is.

## Storage setup

Dashboards live in a **private** bucket named `dashboards` (created for you by the storage migration).

1. In the Supabase dashboard, go to **Storage → dashboards → dashboards/** (the folder).
2. Upload the sample files from [`dashboard-templates/`](dashboard-templates/) in this repo:
   - `Adobe Dashboard.html`
   - `Hiring Dashboard.html`
   - `Sales Dashboard.html`
   - `Marketing Dashboard.html`
3. Insert a row in `public.dashboards` for each file (or run `supabase/seed/seed.sql`), setting `storage_path` to `dashboards/<file name>.html`.

### Adding your own dashboard

Any HTML file works as long as candidate rows follow this convention — no JavaScript required in the file itself:

```html
<tr data-candidate-row data-candidate-name="Jane Doe" data-candidate-email="jane@example.com">
  ...
  <select data-longlist-status></select>
  <input data-longlist-remarks placeholder="Remarks" />
</tr>
```

The host app automatically populates the `<select>` with the 8 standard status options and wires up saving — see `src/lib/dashboardBridge.ts` for the full protocol.

## Authentication

- Email/password auth via Supabase Auth (`src/supabase/auth.ts`).
- Session persisted in local storage and refreshed automatically (`src/context/AuthContext.tsx`).
- Protected routes (`src/components/auth/ProtectedRoute.tsx`) redirect unauthenticated users to `/login`; guest-only routes (`GuestRoute.tsx`) redirect signed-in users away from `/login`.
- Forgot password / reset password flow at `/forgot-password` and `/reset-password`.
- A `profiles` row (with `role`: `admin` | `viewer`) is created automatically for every new user via a database trigger.

## Running locally

```bash
npm run dev       # start the dev server (http://localhost:5173)
npm run build     # type-check and build for production
npm run preview   # preview the production build locally
npm run lint      # ESLint
npm run format    # Prettier (writes)
npm run typecheck # tsc --noEmit
```

A pre-commit hook (Husky + lint-staged) runs ESLint and Prettier on staged files automatically.

## Deployment

### Vercel (frontend)

1. Import the GitHub repository into Vercel.
2. Framework preset: **Vite** (already configured in `vercel.json`, which also adds SPA rewrites so client-side routes don't 404 on refresh).
3. Add the environment variables from [Environment variables](#environment-variables) in **Project Settings → Environment Variables** (for Production, Preview, and Development).
4. Deploy. Every push to `main` redeploys automatically; PRs get preview deployments.
5. Temporary URL: `https://adobe-longlist.vercel.app`. Once ready, add `adobe-longlist.hiresense.ai` as a custom domain in **Project Settings → Domains** and point a CNAME at `cname.vercel-dns.com`.

### Supabase (backend)

Already covered in [Supabase setup](#supabase-setup) — there's nothing separate to "deploy"; migrations applied to your project **are** the deployment. For a staging/production split, use two Supabase projects and two Vercel environments (with their own env vars).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Blank page, console error about missing env vars | `.env.local` is missing or you didn't restart `npm run dev` after adding it |
| "Unauthorized" / redirected to login in a loop | Session expired or `VITE_SUPABASE_ANON_KEY` doesn't match the project in `VITE_SUPABASE_URL` |
| Dashboard list is empty | No rows in `public.dashboards`, or RLS policies weren't applied — re-run `20260720000002_rls_policies.sql` |
| "Couldn't load this dashboard's content" | The file at `storage_path` doesn't exist in the bucket, or storage policies weren't applied — re-run `20260720000003_storage.sql` |
| Status dropdown doesn't save | Check the browser console for the `postMessage` bridge — the candidate row is missing `data-candidate-row`/`data-candidate-name`, or the dashboard's `dashboard_id` doesn't match the route |
| Changes from another tab don't show up live | Realtime wasn't enabled for `dashboard_status` — confirm `20260720000001_init_schema.sql` ran fully (it adds the table to the `supabase_realtime` publication) |
| 404 on refreshing a client-side route in production | SPA rewrites missing — confirm `vercel.json` is present and deployed |

## Production checklist

See [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).
