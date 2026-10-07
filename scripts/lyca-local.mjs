#!/usr/bin/env node
/**
 * LYCA MOBILE — local Supabase stack runner (LOCAL ONLY).
 *
 * Lyca is a physically separate Supabase project. Locally it is a second
 * Supabase CLI stack (workspaces/lyca/supabase/config.toml: project_id
 * "longlist-lyca-local", ports 5532x, its own JWT secret) running next to
 * Adobe's (supabase/config.toml, ports 5432x). This script is the only way
 * to drive it:
 *
 *   npm run lyca:start    sync + start the Lyca stack
 *   npm run lyca:stop     stop it (data is kept)
 *   npm run lyca:status   show its URLs/keys
 *   npm run lyca:reset    sync + rebuild the Lyca LOCAL database from migrations
 *   npm run lyca:sync     refresh the generated migrations/functions copies
 *   npm run lyca:env      print the VITE_LYCA_* lines for .env.local
 *
 * The schema and Edge Functions are the SAME sources Adobe uses
 * (supabase/migrations, supabase/functions) plus the Lyca-only migrations
 * in workspaces/lyca/migrations; "sync" copies them into
 * workspaces/lyca/supabase/ (gitignored) because the CLI only reads a
 * workdir's own supabase/ folder.
 *
 * Guards: every CLI call carries --workdir workspaces/lyca; the config must
 * be the Lyca LOCAL stack; the workdir must never be linked to a hosted
 * project; and the JWT secret must not be the CLI's shared default.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKDIR = join(ROOT, 'workspaces', 'lyca')
const STACK = join(WORKDIR, 'supabase')
const CONFIG = join(STACK, 'config.toml')
const SECRET_FILE = join(WORKDIR, '.env.local')

const LYCA_LOCAL_PROJECT_ID = 'longlist-lyca-local'
const LYCA_LOCAL_API_URL = 'http://127.0.0.1:55321'
const ADOBE_LOCAL_API_URL = 'http://127.0.0.1:54321'
// The Supabase CLI's built-in local JWT secret — shared by every local stack
// that doesn't override it (Adobe's included), so Lyca must never use it.
const CLI_DEFAULT_JWT_SECRET =
  'super-secret-jwt-token-with-at-least-32-characters-long'

function fail(message) {
  console.error(`\n[lyca-local] BLOCKED: ${message}\n`)
  process.exit(1)
}

function assertLycaLocalConfig() {
  const config = readFileSync(CONFIG, 'utf8')
  if (
    !config.includes(`
project_id = "${LYCA_LOCAL_PROJECT_ID}"`)
  ) {
    fail(`${CONFIG} is not the Lyca local stack (project_id).`)
  }
  if (!/^\[api\]\s*\nport = 55321$/m.test(config)) {
    fail(`${CONFIG} must serve the Lyca API on port 55321.`)
  }
  if (existsSync(join(STACK, '.temp', 'project-ref'))) {
    fail(
      'workspaces/lyca is LINKED to a hosted Supabase project. This runner is ' +
        'local-only — unlink it (npx supabase unlink --workdir workspaces/lyca).',
    )
  }
}

function readJwtSecret({ create }) {
  let secret = null
  if (existsSync(SECRET_FILE)) {
    const match = readFileSync(SECRET_FILE, 'utf8').match(
      /^LYCA_LOCAL_JWT_SECRET=(.+)$/m,
    )
    secret = match?.[1].trim() ?? null
  }
  if (!secret && create) {
    secret = randomBytes(48).toString('base64url')
    writeFileSync(
      SECRET_FILE,
      '# LOCAL ONLY — JWT secret of the local Lyca Supabase stack. Gitignored.\n' +
        `LYCA_LOCAL_JWT_SECRET=${secret}\n`,
    )
    console.log('[lyca-local] Generated a new local JWT secret (gitignored).')
  }
  if (!secret) fail('No local JWT secret yet — run `npm run lyca:start` first.')
  if (secret === CLI_DEFAULT_JWT_SECRET || secret.length < 32) {
    fail('The Lyca local JWT secret must be ≥32 chars and not the CLI default.')
  }
  return secret
}

// Lyca's own ES256 key for user access tokens (config: signing_keys_path).
// Without it the CLI signs every local stack's user tokens with one shared
// built-in key, so a Lyca token would also verify on Adobe's stack.
function ensureSigningKey() {
  const keysFile = join(STACK, 'signing_keys.json')
  const existing = existsSync(keysFile)
    ? JSON.parse(readFileSync(keysFile, 'utf8') || '[]')
    : []
  if (Array.isArray(existing) && existing.some((k) => k.d && k.kid)) return
  writeFileSync(keysFile, '[]')
  cli(['gen', 'signing-key', '--algorithm', 'ES256', '--yes'])
  console.log(
    '[lyca-local] Generated a Lyca-only JWT signing key (gitignored).',
  )
}

function sync() {
  const migrationsOut = join(STACK, 'migrations')
  rmSync(migrationsOut, { recursive: true, force: true })
  mkdirSync(migrationsOut, { recursive: true })
  const sources = [
    join(ROOT, 'supabase', 'migrations'),
    join(WORKDIR, 'migrations'),
  ]
  const seen = new Set()
  for (const dir of sources) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      if (seen.has(file)) fail(`Duplicate migration file name: ${file}`)
      seen.add(file)
      cpSync(join(dir, file), join(migrationsOut, file))
    }
  }
  const functionsOut = join(STACK, 'functions')
  rmSync(functionsOut, { recursive: true, force: true })
  cpSync(join(ROOT, 'supabase', 'functions'), functionsOut, {
    recursive: true,
  })
  // No seed.sql: Lyca's API-role grants are a real migration
  // (workspaces/lyca/migrations/20261008000000_api_role_grants.sql), so this
  // local stack is built exactly like the hosted Lyca project.
  rmSync(join(STACK, 'seed.sql'), { force: true })
  console.log(
    `[lyca-local] Synced ${seen.size} migrations and Edge Functions into workspaces/lyca/supabase/.`,
  )
}

function cli(args, { capture = false } = {}) {
  const secret = readJwtSecret({
    create: args[0] === 'start' || args[0] === 'gen',
  })
  const fullArgs = ['supabase', ...args, '--workdir', 'workspaces/lyca']
  if (!capture) console.log(`[lyca-local] > npx ${fullArgs.join(' ')}`)
  const result = spawnSync('npx', fullArgs, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, LYCA_LOCAL_JWT_SECRET: secret },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

const [, , command] = process.argv
assertLycaLocalConfig()

switch (command) {
  case 'sync':
    sync()
    break
  case 'start':
    sync()
    ensureSigningKey()
    cli(['start'])
    break
  case 'stop':
    cli(['stop'])
    break
  case 'status':
    cli(['status'])
    break
  case 'reset':
    sync()
    cli(['db', 'reset', '--local'])
    break
  case 'env': {
    const status = JSON.parse(cli(['status', '-o', 'json'], { capture: true }))
    if (
      status.API_URL !== LYCA_LOCAL_API_URL ||
      status.API_URL === ADOBE_LOCAL_API_URL
    ) {
      fail(`Unexpected Lyca API URL ${status.API_URL}`)
    }
    console.log(`VITE_LYCA_SUPABASE_URL=${status.API_URL}`)
    console.log(`VITE_LYCA_SUPABASE_ANON_KEY=${status.ANON_KEY}`)
    break
  }
  default:
    fail(
      'usage: node scripts/lyca-local.mjs <start|stop|status|reset|sync|env>',
    )
}
