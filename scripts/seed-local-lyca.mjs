#!/usr/bin/env node
/**
 * LOCAL LYCA test data (npm run lyca:seed) — writes ONLY to the local Lyca
 * Supabase stack (http://127.0.0.1:55321, see scripts/lyca-local.mjs). It
 * never reads from or writes to Adobe's stack or any hosted project; nothing
 * in it comes from Adobe data.
 *
 * Creates (idempotently):
 *   - lyca-super-admin@local.test (Super Admin), lyca-admin@local.test
 *     (Admin), lyca-viewer@local.test (Viewer) — password: the
 *     LOCAL_TEST_ACCOUNTS_PASSWORD value from the gitignored .env.local
 *     (or the same-named environment variable). Optionally one more Super
 *     Admin from LYCA_EXTRA_SUPER_ADMIN_EMAIL / LYCA_EXTRA_SUPER_ADMIN_PASSWORD
 *     (environment only — never written anywhere).
 *   - 1 requirement, 1 dashboard (SYNTHETIC HTML, 5 fictional candidates,
 *     uploaded to Lyca Storage only), the Viewer's assignment to it, and
 *     sample candidate actions and notes written as the signed-in users (so
 *     they go through RLS and the server-side audit fields).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  buildSyntheticDashboardHtml,
  syntheticCandidates,
} from './lib/synthetic-dashboard.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LYCA_LOCAL_API_URL = 'http://127.0.0.1:55321'
const ADOBE_LOCAL_API_URL = 'http://127.0.0.1:54321'

function fail(message) {
  console.error(`\n[seed-local-lyca] BLOCKED: ${message}\n`)
  process.exit(1)
}

function readEnvFile(path, key) {
  if (!existsSync(path)) return null
  const match = readFileSync(path, 'utf8').match(
    new RegExp(`^${key}=(.+)$`, 'm'),
  )
  return match?.[1].trim() ?? null
}

function stackStatus(workdirArgs, env) {
  const r = spawnSync(
    'npx',
    ['supabase', 'status', '-o', 'json', ...workdirArgs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, ...env },
    },
  )
  if (r.status !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

// --- Target: the local Lyca stack, and nothing else ------------------------
const jwtSecret = readEnvFile(
  join(ROOT, 'workspaces', 'lyca', '.env.local'),
  'LYCA_LOCAL_JWT_SECRET',
)
if (!jwtSecret) fail('Lyca stack not initialised — run `npm run lyca:start`.')
const lyca = stackStatus(['--workdir', 'workspaces/lyca'], {
  LYCA_LOCAL_JWT_SECRET: jwtSecret,
})
if (!lyca) fail('Lyca stack is not running — run `npm run lyca:start`.')
if (lyca.API_URL !== LYCA_LOCAL_API_URL) {
  fail(`Expected the Lyca stack at ${LYCA_LOCAL_API_URL}, got ${lyca.API_URL}.`)
}
const adobe = stackStatus([], {})
if (adobe) {
  if (adobe.API_URL === lyca.API_URL) fail('Lyca and Adobe share an API URL.')
  if (adobe.API_URL !== ADOBE_LOCAL_API_URL) {
    fail(`Unexpected Adobe local API URL ${adobe.API_URL}.`)
  }
  if (adobe.SERVICE_ROLE_KEY === lyca.SERVICE_ROLE_KEY) {
    fail(
      'Lyca and Adobe share a service key — Lyca must use its own JWT secret.',
    )
  }
}

const API = lyca.API_URL
const SERVICE_KEY = lyca.SERVICE_ROLE_KEY
const ANON_KEY = lyca.ANON_KEY
const password =
  process.env.LOCAL_TEST_ACCOUNTS_PASSWORD ??
  readEnvFile(join(ROOT, '.env.local'), 'LOCAL_TEST_ACCOUNTS_PASSWORD')
if (!password || password.length < 12) {
  fail('Set LOCAL_TEST_ACCOUNTS_PASSWORD (≥12 chars) in .env.local.')
}

const serviceHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  'Content-Type': 'application/json',
}

async function rest(path, init = {}, headers = serviceHeaders) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    ...init,
    headers: { Prefer: 'return=representation', ...headers, ...init.headers },
  })
  const text = await res.text()
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// --- Users ------------------------------------------------------------------
async function ensureUser(email, userPassword, name, role) {
  let userId
  const created = await fetch(`${API}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      email,
      password: userPassword,
      email_confirm: true,
    }),
  })
  const body = await created.json()
  if (created.ok) {
    userId = body.id
  } else {
    const [existing] = await rest(
      `profiles?email=eq.${encodeURIComponent(email)}&select=id`,
    )
    if (!existing)
      throw new Error(`Could not create ${email}: ${JSON.stringify(body)}`)
    userId = existing.id
    // Only reset the password when it no longer matches: a password change
    // signs every open session of that user out.
    const check = await fetch(`${API}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: userPassword }),
    })
    if (!check.ok) {
      await fetch(`${API}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: serviceHeaders,
        body: JSON.stringify({ password: userPassword }),
      })
    }
  }
  await rest(`profiles?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      role,
      name,
      locked_at: null,
      failed_login_attempts: 0,
      force_password_change: false,
    }),
  })
  console.log(`  ${role.padEnd(11)} ${email}`)
  return userId
}

console.log(`Seeding the LOCAL Lyca stack at ${API}:`)
const superAdminId = await ensureUser(
  'lyca-super-admin@local.test',
  password,
  'Lyca Super Admin (test)',
  'super_admin',
)
const adminId = await ensureUser(
  'lyca-admin@local.test',
  password,
  'Lyca Admin (test)',
  'admin',
)
const viewerId = await ensureUser(
  'lyca-viewer@local.test',
  password,
  'Lyca Viewer (test)',
  'viewer',
)
const extraEmail = process.env.LYCA_EXTRA_SUPER_ADMIN_EMAIL
const extraPassword = process.env.LYCA_EXTRA_SUPER_ADMIN_PASSWORD
if (extraEmail && extraPassword) {
  await ensureUser(extraEmail, extraPassword, 'HireSense Admin', 'super_admin')
}

// --- Dashboard (synthetic HTML in Lyca Storage) ----------------------------
const DASHBOARD_TITLE = 'SYNTHETIC LYCA TEST DASHBOARD — Senior Data Engineer'
let [dashboard] = await rest(
  `dashboards?title=eq.${encodeURIComponent(DASHBOARD_TITLE)}&select=id,storage_path`,
)
const dashboardId = dashboard?.id ?? randomUUID()
const storagePath = dashboard?.storage_path ?? `dashboards/${dashboardId}.html`
// (Re)upload every run, so the stored HTML always matches the generator.
const upload = await fetch(
  `${API}/storage/v1/object/dashboards/${storagePath}`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'text/html',
      'x-upsert': 'true',
    },
    body: buildSyntheticDashboardHtml({ title: DASHBOARD_TITLE, count: 5 }),
  },
)
if (!upload.ok)
  throw new Error(`Upload failed: ${upload.status} ${await upload.text()}`)
if (!dashboard) {
  const id = dashboardId
  ;[dashboard] = await rest('dashboards', {
    method: 'POST',
    body: JSON.stringify({
      id,
      title: DASHBOARD_TITLE,
      description: 'Synthetic local test data — 5 fictional candidates.',
      category: 'Data Engineering (synthetic)',
      file_name: 'synthetic-lyca-dashboard.html',
      storage_path: storagePath,
      created_by: superAdminId,
    }),
  })
}
console.log(`  dashboard   ${DASHBOARD_TITLE} (${dashboard.id})`)

await rest('dashboard_assignments?on_conflict=dashboard_id,user_id', {
  method: 'POST',
  headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
  body: JSON.stringify({
    dashboard_id: dashboard.id,
    user_id: viewerId,
    assigned_by: superAdminId,
  }),
})
console.log('  assignment  lyca-viewer@local.test → that dashboard')

// --- Requirement --------------------------------------------------------------
const REQUIREMENT_TITLE =
  'SYNTHETIC LYCA TEST REQUIREMENT — Senior Data Engineer'
let [requirement] = await rest(
  `requirements?title=eq.${encodeURIComponent(REQUIREMENT_TITLE)}&select=id`,
)
if (!requirement) {
  ;[requirement] = await rest('requirements', {
    method: 'POST',
    body: JSON.stringify({
      title: REQUIREMENT_TITLE,
      jd_text:
        'Synthetic local test requirement. Build and run batch and streaming data pipelines; SQL, Python and an orchestration tool.',
      status: 'In Progress',
      created_by: adminId,
      relevant_experience: 4,
      total_experience: 7,
      role_type: 'ic',
      not_a_fit: 'Synthetic test data.',
      ideal_candidate: 'Synthetic test data.',
      dashboard_id: dashboard.id,
    }),
  })
  const rid = requirement.id
  await rest('requirement_top_skills', {
    method: 'POST',
    body: JSON.stringify([
      { requirement_id: rid, skill: 'SQL', position: 0 },
      { requirement_id: rid, skill: 'Python', position: 1 },
    ]),
  })
  await rest('requirement_optional_skills', {
    method: 'POST',
    body: JSON.stringify([
      { requirement_id: rid, skill: 'Airflow', position: 0 },
    ]),
  })
  await rest('requirement_target_companies', {
    method: 'POST',
    body: JSON.stringify([
      {
        requirement_id: rid,
        company: 'Contoso Networks (fictional)',
        position: 0,
      },
    ]),
  })
}
console.log(`  requirement ${REQUIREMENT_TITLE} (${requirement.id})`)

// --- Sample actions + notes, written AS the users (RLS + audit triggers) ----
async function signIn(email) {
  const res = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!res.ok)
    throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body)}`)
  return {
    Authorization: `Bearer ${body.access_token}`,
    apikey: ANON_KEY,
    'Content-Type': 'application/json',
  }
}
const asAdmin = await signIn('lyca-admin@local.test')
const asViewer = await signIn('lyca-viewer@local.test')
const upsert = (table, row, headers) =>
  rest(
    `${table}?on_conflict=dashboard_id,candidate_name`,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ dashboard_id: dashboard.id, ...row }),
    },
    headers,
  )
const [first, second, third] = syntheticCandidates(5).map((c) => c.name)
await upsert(
  'dashboard_status',
  { candidate_name: first, action: 'Screen Select - HireSense' },
  asAdmin,
)
await upsert(
  'dashboard_status',
  { candidate_name: second, action: 'Candidate Yet to Revert' },
  asViewer,
)
await upsert(
  'dashboard_status',
  { candidate_name: third, action: 'Interview stage - Adobe' },
  asAdmin,
)
await upsert(
  'candidate_notes',
  {
    candidate_name: first,
    note: 'Synthetic note: strong SQL; schedule a technical screen.',
  },
  asAdmin,
)
await upsert(
  'candidate_notes',
  {
    candidate_name: second,
    note: 'Synthetic note: awaiting reply to outreach.',
  },
  asViewer,
)
console.log('  actions     3 sample candidate actions (Admin + Viewer)')
console.log('  notes       2 sample notes (Admin + Viewer)')
console.log('\nDone. Sign in at http://localhost:5173/lyca/login (LOCAL only).')
