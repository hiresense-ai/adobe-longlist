# Adobe Longlist — Security Audit & Hardening Report

**Date:** 2026-07-21
**Scope:** Authentication, authorization, RLS, Storage, Edge Functions, HTTP headers, file upload, HTML viewer, input validation, dependencies, and production readiness.
**Constraint honored throughout:** no business logic changes, no UI redesign, no breaking DB changes, all existing features preserved and re-verified after hardening.

---

## 1. Production readiness score: **8.5 / 10**

Ready for production use as an internal tool. The remaining 1.5 points are the items in [§5 Remaining recommendations](#5-remaining-recommendations) — none are blocking, all are worth scheduling.

---

## 2. Findings & fixes

### High

| # | Finding | Fix |
|---|---|---|
| H1 | Dashboard HTML upload had **no server-side size limit matching spec and no MIME-type check at all** — only the filename extension was validated. An oversized or mistyped file could be uploaded without limit. | Added `MAX_HTML_SIZE_BYTES` (10 MB) + MIME check to `validateHtmlFile()`; storage bucket ceiling lowered from 25 MB → 10 MB as a server-side backstop. |
| H2 | **SVG was an allowed thumbnail MIME type** at the storage-bucket level. SVG can embed `<script>`; a signed thumbnail URL opened directly (not via `<img>`) would execute attacker JS in the storage origin — stored XSS. | Removed `image/svg+xml` from `storage.buckets.allowed_mime_types`. Verified: SVG upload now rejected server-side with `mime type image/svg+xml is not supported`. |
| H3 | Password policy was **8 chars, no special character**, and inconsistent: the post-reset-email "new password" form had almost no policy at all (6 chars, zero complexity) — weaker than user creation. | Raised to 12+ chars with upper/lower/digit/special char, enforced identically in the Edge Function (server) and both the create-user and reset-password forms (client). **The sign-in form was deliberately left unchanged** so existing accounts with older, shorter passwords aren't locked out. |

### Medium

| # | Finding | Fix |
|---|---|---|
| M1 | RLS allowed any authenticated user to update their own `profiles.email` directly via the client SDK, bypassing Supabase Auth's real email-change flow — able to desync `profiles.email` from `auth.users.email` (the exact bug that broke admin login previously). | Added a trigger (mirroring the existing role-escalation guard) that silently reverts any direct-session change to `email`. Only the service-role Edge Function may change it. Verified: a viewer's self-attempted email change is silently reverted. |
| M2 | `admin-users` Edge Function sent `Access-Control-Allow-Origin: *`. | Replaced with an exact allowlist (localhost dev + the production Vercel domain). The real gate is still the JWT + admin-role check; this narrows which sites a browser will even attempt the request from. |
| M3 | No audit trail existed for user management or dashboard upload/delete. | New `audit_logs` table (admin-read-only, no client write path at all — inserts only via security-definer triggers or the service-role Edge Function). Records actor, action, target, metadata, timestamp for every create/update/role-change/disable/enable/delete and every dashboard upload/delete. Verified end-to-end. |
| M4 | No rate limiting on the admin API or on dashboard upload/delete — a leaked/compromised admin session could be scripted into mass actions. | Edge Function: 30 mutating actions / 10 min per admin, backed by `audit_logs`. Dashboards table: DB triggers cap uploads at 10 / 10 min and deletes at 20 / 10 min per user, enforced regardless of which client calls the API. |
| M5 | No CSP, Permissions-Policy, HSTS, or `frame-ancestors`; only `X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy` were set. | Added all of the above to `vercel.json`, tuned so the sandboxed `blob:` dashboard iframe, Supabase REST/Storage/Realtime, and self-hosted fonts keep working (`frame-src blob:`, `connect-src` incl. `wss:` for Realtime, `img-src` incl. the Supabase Storage origin). Verified live: headers present, iframe still renders, zero console/CSP errors. |
| M6 | iframe sandbox included `allow-popups`, unused by any of the 4 current dashboard templates — unnecessary attack surface for untrusted uploaded HTML. | Removed. Sandbox is now `allow-scripts allow-forms allow-modals` (still deliberately no `allow-same-origin`, no `allow-top-navigation`). |

### Low

| # | Finding | Fix |
|---|---|---|
| L1 | `.env.example` contained the real production project URL and anon key instead of placeholders. | Replaced with generic placeholder values. (Not a secret leak — the anon key is meant to be public and RLS-protected — just poor template hygiene.) |
| L2 | No length caps on `dashboards.title/description/category` or `dashboard_status.candidate_name/remarks`. | Added generous `CHECK` constraints (200–2000 chars) — additive, no existing row affected. |
| L3 | Edge Function returned 400 instead of 404 for "user not found" on update/disable/delete. | Added `isNotFoundError()` mapping. |
| L4 | No cap on Edge Function request body size before parsing. | Added a 10 KB body-size guard, returns 413 if exceeded. |

### Already secure — verified, no change needed

- **postMessage bridge** checks `event.source === iframeRef.current.contentWindow`, not `event.origin` — correctly immune to message spoofing from any other window (stronger than an origin check, since the sandboxed iframe has an opaque origin anyway). Documented with a comment for the next reader.
- **iframe sandbox** already correctly omits `allow-same-origin` — the one addition that would actually be dangerous combined with `allow-scripts` (it would let the sandboxed HTML strip its own sandbox and reach this app's cookies/storage).
- `dashboard_status` RLS (`any authenticated user can read/write any dashboard's statuses`) is intentional, explicit business logic from the original spec, not a bug — left untouched.
- No `dangerouslySetInnerHTML`, `eval`, or raw-HTML-injection sink anywhere in the React app.
- Storage bucket already private with RLS enforcing authenticated-read / admin-only write.
- `service_role` key never reaches the frontend; the Edge Function's "verify caller via anon-scoped client, then act via a separate service-role client" pattern was already correct.
- No secrets found in git history; `.env`/`.env.local` correctly gitignored and never tracked.
- `npm audit` (prod + dev): **0 known vulnerabilities**.
- Admin Users and Dashboard Viewer pages were already code-split via `React.lazy`.
- Auth session handling (`persistSession`, `autoRefreshToken`, `detectSessionInUrl`) uses supabase-js's secure defaults; `ProtectedRoute`/`GuestRoute`/`AdminRoute` correctly gate on session + role with no loading-state race.

---

## 3. Incident found during verification (unrelated to this hardening pass)

While re-testing the dashboard list after deploying, the **Marketing Dashboard** (one of the 4 original seeded dashboards) was found missing — both its database row and its HTML file in Storage were gone.

- I traced every database/API action from this session and found nothing that deletes from `dashboards` — the loss predates the `audit_logs` table I added, so there's no record of who/what/when.
- I queried Supabase's log tables (`postgres_logs`, `edge_logs`) via the Management API; both came back empty for the full date range — consistent with short/no log retention on this plan, not a tooling failure on my end.
- With your approval, I **restored it** from `dashboard-templates/Marketing Dashboard.html` (the original file already in this repo), re-uploaded through the same storage + metadata path the app itself uses, and confirmed it renders correctly. Root cause remains unconfirmed — if you have Supabase's web Logs Explorer available with longer retention, or a PITR backup, it may still be worth a look.

---

## 4. Testing performed

- Weak password (8 char, no special) → **rejected** (400) by the Edge Function.
- Strong password (12+, upper/lower/digit/special) → **accepted**, audit log entry recorded with correct actor/target.
- Non-admin reading `audit_logs` → **empty result** (RLS denies).
- Non-admin (viewer) attempting to change their own `profiles.email` directly → **silently reverted**, value unchanged.
- SVG thumbnail upload → **rejected** at the storage layer (`mime type image/svg+xml is not supported`).
- 11 MB HTML upload → **rejected** (`object exceeded the maximum allowed size`).
- Normal small HTML upload → **still succeeds** (no regression).
- Existing admin password (10 chars, no special char, predates the new policy) → **still logs in** (login form deliberately decoupled from the new policy).
- CSP/HSTS/Permissions-Policy headers live in production → confirmed via response headers; iframe (`blob:`) rendering, Supabase REST/Realtime, thumbnails, and fonts all still work with **zero console/CSP errors**.
- Viewer role → correctly gets the `Forbidden` (403) page on `/admin/users` and a 403 JSON error calling the Edge Function directly (re-confirmed from the prior task, unaffected by this pass).
- Admin Users page (list/create/edit/disable/delete), dashboard upload/delete, dashboard viewer, dark mode, and mobile breakpoint (`Users` link correctly moves into the mobile menu under `md`) all re-verified in production after deployment.
- `npm run typecheck`, `npm run lint`, `npm run build` — all clean, both before and after the Vercel-side prettier/eslint auto-formatting from the commit hook.

---

## 5. Remaining recommendations

Not blocking, but worth doing next:

1. **Enable a CAPTCHA/Turnstile challenge** on login and password-reset in Supabase Auth settings — GoTrue already rate-limits these server-side, but a challenge adds defense against distributed brute-force.
2. **Confirm Point-in-Time Recovery / backup retention** on the Supabase project (relevant given §3) and consider upgrading log retention if forensic visibility matters to you.
3. **Consider moving dashboard upload/delete behind an Edge Function** (like `admin-users`) if you ever want magic-byte-level content sniffing instead of trusting the client-declared MIME type — today's fix (extension + declared MIME + bucket allowlist + size cap) blocks casual mistakes and most real attacks, but a determined admin-level actor could still mislabel a file's Content-Type when calling the Storage API directly. Low priority since only trusted admins can upload at all.
4. **Wire up a periodic `npm audit`** (e.g., a scheduled CI job or Dependabot) so the current clean bill of health doesn't silently drift.
5. If this repo is ever made public or forked, double check `.env.example` stays placeholder-only (now fixed) and no real keys creep back in.

---

## 6. Files changed

- `supabase/migrations/20260721000001_security_hardening.sql` — new
- `supabase/functions/admin-users/index.ts` — hardened
- `src/constants/index.ts`, `src/services/dashboardAdmin.service.ts`, `src/components/dashboard/UploadDashboardDialog.tsx`, `src/components/dashboard/DashboardFrame.tsx`, `src/hooks/useDashboardStatusBridge.ts`
- `src/components/admin/CreateUserDialog.tsx`, `src/pages/Login/ResetPassword.tsx`, `src/pages/Login/Login.tsx`
- `vercel.json`, `.env.example`
