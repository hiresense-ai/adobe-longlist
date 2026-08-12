#!/usr/bin/env node
/**
 * Seeds the LOCAL Supabase stack with the initial Super Admin account.
 *
 * Physically incapable of touching production: the target URL is hardcoded
 * to the local stack (127.0.0.1), and the service key is read live from
 * `supabase status` — i.e. from the running local containers, which have
 * their own throwaway keys that production would never accept.
 *
 * Usage:
 *   node scripts/seed-local-admin.mjs <email> <password>
 *
 * No hardcoded credentials: both arguments are required, chosen by you at
 * run time, and exist only in the local stack.
 */
import { spawnSync } from 'node:child_process'

const LOCAL_URL = 'http://127.0.0.1:54321'
const email = process.argv[2]
const password = process.argv[3]

if (!email || !password) {
  console.error(
    'Usage: node scripts/seed-local-admin.mjs <email> <password>\n' +
      '(both required — this script has no built-in default credentials)',
  )
  process.exit(1)
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters (app policy).')
  process.exit(1)
}

const status = spawnSync('npx', ['supabase', 'status', '-o', 'json'], {
  encoding: 'utf8',
  shell: true,
})
if (status.status !== 0) {
  console.error(
    'Could not read local stack status — is it running? Start it with: npm run local:start',
  )
  process.exit(1)
}
let parsed
try {
  parsed = JSON.parse(status.stdout)
} catch {
  console.error('Unexpected `supabase status` output:\n' + status.stdout)
  process.exit(1)
}
const serviceKey =
  parsed.SERVICE_ROLE_KEY || parsed.service_role_key || parsed.ServiceRoleKey
const apiUrl = parsed.API_URL || parsed.api_url || LOCAL_URL
if (!serviceKey) {
  console.error('No SERVICE_ROLE_KEY in `supabase status` output.')
  process.exit(1)
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
  console.error(
    `Refusing to run: local stack API URL looks non-local (${apiUrl}).`,
  )
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${serviceKey}`,
  apikey: serviceKey,
  'Content-Type': 'application/json',
}

// Create (or find) the auth user; handle_new_user creates the profile row.
let userId
const createRes = await fetch(`${apiUrl}/auth/v1/admin/users`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ email, password, email_confirm: true }),
})
const createBody = await createRes.json()
if (createRes.ok) {
  userId = createBody.id
  console.log(`Created local user ${email} (${userId})`)
} else if (
  createRes.status === 422 ||
  /already.*registered|exists/i.test(JSON.stringify(createBody))
) {
  const listRes = await fetch(
    `${apiUrl}/auth/v1/admin/users?page=1&per_page=100`,
    { headers: H },
  )
  const listBody = await listRes.json()
  const existing = (listBody.users || []).find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  )
  if (!existing) {
    console.error('User reported as existing but not found:', createBody)
    process.exit(1)
  }
  userId = existing.id
  console.log(`Local user ${email} already exists (${userId})`)
} else {
  console.error('Failed to create local user:', createRes.status, createBody)
  process.exit(1)
}

// Promote to super_admin, unlocked, ready to log in.
const patchRes = await fetch(`${apiUrl}/rest/v1/profiles?id=eq.${userId}`, {
  method: 'PATCH',
  headers: { ...H, Prefer: 'return=representation' },
  body: JSON.stringify({
    role: 'super_admin',
    // Display name derived from the email's local part (e.g. "praveen" →
    // "Praveen"); editable later from the Users page.
    name: email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    locked_at: null,
    failed_login_attempts: 0,
    force_password_change: false,
  }),
})
const patchBody = await patchRes.json()
if (!patchRes.ok || !patchBody.length) {
  console.error('Failed to promote profile:', patchRes.status, patchBody)
  process.exit(1)
}
console.log(
  `Local Super Admin ready → ${email} / ${password}  (LOCAL stack only: ${apiUrl})`,
)
