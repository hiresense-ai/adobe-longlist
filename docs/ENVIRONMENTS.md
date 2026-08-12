# Environments: LOCAL vs PRODUCTION

There are exactly two environments. There is no Dev and no QA.

| | LOCAL | PRODUCTION |
|---|---|---|
| Frontend | `npm run dev` (Vite, localhost:5173) | Vercel (deploys `main`) |
| Supabase | Local Docker stack (`supabase start`) at `http://127.0.0.1:54321` | Hosted project `lomiqhcbjivdgophreiw` |
| Database | Local Postgres (port 54322) | Production Postgres |
| Auth / Storage / Realtime / Edge Functions | All local containers | All hosted |
| Credentials | `.env.local` (local stack keys) | Vercel **Production** env vars only |

**Zero runtime data is shared between the two.** A local write can never
reach production, and production data never appears locally.

> **NEVER point local .env files to the Production Supabase project.**
> The app hard-refuses to start in dev mode if `.env.local` contains the
> production URL (`src/supabase/client.ts`), and the dev UI shows an
> `Environment: LOCAL` badge (bottom-left) so you always know what you're
> connected to.

---

## LOCAL

### One-time setup

1. Install Docker Desktop and make sure it is running.
2. `npm run local:start` — boots the local Supabase stack and applies every
   migration in `supabase/migrations/` plus `supabase/seed.sql`.
3. `npm run local:status` — prints the local API URL and keys.
4. Ensure `.env.local` contains the local values (see `.env.example`):
   - `VITE_SUPABASE_URL=http://127.0.0.1:54321`
   - `VITE_SUPABASE_ANON_KEY=<ANON_KEY from local:status>`
5. `npm run local:seed-admin -- <email> <password>` — creates a local Super
   Admin with credentials YOU choose (no defaults are hardcoded anywhere;
   password must be 12+ characters). The account exists only in the local
   stack — even reusing a production email creates a completely separate
   local account.

### Daily use

- `npm run dev` — the app talks to the local stack.
- Edge Functions in `supabase/functions/` are served automatically by the
  local stack at `http://127.0.0.1:54321/functions/v1/<name>` — no deploy
  step; edits are picked up locally.
- `npm run local:stop` stops the containers (state is kept);
  `npm run local:reset` wipes the local DB and re-applies all migrations +
  seed (re-run `npm run local:seed-admin -- <email> <password>` afterwards —
  a reset wipes local users too).
- Local Studio: http://127.0.0.1:54323 · Local email inbox (password
  resets etc.): http://127.0.0.1:54324

### Local migration workflow

1. Add a new file to `supabase/migrations/` (timestamp-prefixed).
2. `npm run local:reset` (or `npx supabase migration up`) to apply locally.
3. Test in the local app.
4. Commit the migration file.
5. Production receives it ONLY via the explicit production push below —
   never automatically.

### seed.sql

`supabase/seed.sql` runs ONLY on the local stack (`start`/`reset` — a
production `db push` never executes it). It replicates the table/function
grants the production project already has (production was created on an
older Supabase baseline that auto-granted DML/EXECUTE to the API roles;
the current local Postgres image does not), and nothing else. App security
is enforced by RLS in the migrations, not by these grants.

---

## PRODUCTION

- Vercel builds `main` and injects `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` from its **Production** environment variables.
  Those values exist only in Vercel — never in any file in this repo.
- The repo is deliberately **UNLINKED** from the production Supabase
  project: a plain `supabase db push` or `supabase functions deploy` fails
  with "Cannot find project ref" instead of touching production.
- The ONLY way to deploy to production Supabase:

  ```bash
  # migrations (temporarily links, pushes, ALWAYS unlinks again):
  PROD_DEPLOY_CONFIRM=lomiqhcbjivdgophreiw npm run prod:db-push

  # a single Edge Function:
  PROD_DEPLOY_CONFIRM=lomiqhcbjivdgophreiw npm run prod:functions-deploy -- admin-users
  ```

  Without `PROD_DEPLOY_CONFIRM` set to the production project ref, the
  script refuses to run. Typing the ref IS the confirmation.

### Footguns

- **`vercel env pull` overwrites `.env.local`.** If you run it, restore the
  local values from `npm run local:status`. The app's dev-mode guard will
  refuse to start against production either way, so the failure is loud,
  not silent.
- Never add production keys to `.env.local`, `.env`, or any committed file.
- Never bypass `scripts/prod-deploy.mjs` by re-linking manually.
