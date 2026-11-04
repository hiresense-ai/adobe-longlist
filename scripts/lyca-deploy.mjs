#!/usr/bin/env node
/**
 * The ONLY sanctioned path for applying anything to the hosted LYCA MOBILE
 * Supabase project (adfubeifnsgxwmpfslkt). Adobe's production project is
 * handled exclusively by scripts/prod-deploy.mjs and is refused here.
 *
 *   LYCA_DEPLOY_CONFIRM=adfubeifnsgxwmpfslkt node scripts/lyca-deploy.mjs <command>
 *
 * Commands:
 *   migration-list            show local vs remote migration versions
 *   db-push-dry-run           show what db-push would apply (changes nothing)
 *   db-push                   apply pending migrations
 *   functions-deploy [name]   deploy one / every Edge Function. Refused while
 *                             the Lyca database has not applied every
 *                             migration in this checkout (deploying code that
 *                             writes a column the database lacks would pay a
 *                             vendor and lose the answer): run db-push first.
 *   db-query <file.sql>       run one reviewed SQL file on the Lyca database
 *                             (through the Management API, `supabase db query
 *                             --linked`). For one-off setup that must not
 *                             live in a migration, e.g. the contact-store-sync
 *                             schedule (HIR-526). Only:
 *                             - a file directly in workspaces/lyca/ops/,
 *                               committed and unchanged in this checkout;
 *                             - with its sha256 confirmed:
 *                               LYCA_DB_QUERY_SHA256=<the sha256 it prints>.
 *                             A placeholder __NAME__ in the file is filled
 *                             from env LYCA_SQL_NAME (e.g. a secret, which so
 *                             never sits in git or in a file of yours). The
 *                             filled-in copy lives only in the work directory
 *                             below. The CLI's output is printed with every
 *                             filled-in value replaced by [redacted].
 *   ops-sha256                print the sha256 of every committed file in
 *                             workspaces/lyca/ops/ (local only, no project).
 *
 * db-push, functions-deploy and db-query refuse a checkout with uncommitted
 * changes under supabase/, workspaces/lyca/ or scripts/, and print the commit
 * they deploy: what goes out is a commit someone can look at.
 *
 * Every command runs in a throw-away work directory assembled from the same
 * sources as the local Lyca stack (supabase/migrations + workspaces/lyca/
 * migrations, supabase/functions), linked to the Lyca ref only for the
 * command and always unlinked afterwards. The repo's own supabase/ and
 * workspaces/lyca/ directories are never linked. The Supabase CLI is run
 * without a shell (arguments are never re-parsed).
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OPS_DIR,
  opsQueryFile,
  redact,
  renderSql,
  sha256,
  unappliedMigrations,
} from './lib/lyca-deploy-checks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LYCA_PROJECT_REF = 'adfubeifnsgxwmpfslkt'
const ADOBE_PRODUCTION_PROJECT_REF = 'lomiqhcbjivdgophreiw'

function fail(message) {
  console.error(`\n[lyca-deploy] BLOCKED: ${message}\n`)
  process.exit(1)
}

const [, , command, name] = process.argv
const commands = [
  'migration-list',
  'db-push-dry-run',
  'db-push',
  'functions-deploy',
  'db-query',
  'ops-sha256',
]
if (!commands.includes(command)) {
  fail(`usage: node scripts/lyca-deploy.mjs <${commands.join(' | ')}>`)
}
const mutating = ['db-push', 'functions-deploy', 'db-query'].includes(command)

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

// --- db-query: only a reviewed, committed file, with its sha256 confirmed ---

/**
 * A file of workspaces/lyca/ops as committed: committed, unchanged in this
 * checkout, read from HEAD. What runs, and what is hashed, is the committed
 * blob (git's line endings, so the sha256 is the same on every machine).
 */
function committedOpsFile(arg) {
  let file
  try {
    file = opsQueryFile(ROOT, arg)
  } catch (error) {
    fail(error.message)
  }
  if (!existsSync(file)) fail(`no such file: ${relative(ROOT, file)}`)
  const rel = relative(ROOT, file).split(sep).join('/')
  if (!git(['ls-files', '--error-unmatch', '--', rel]).ok) {
    fail(
      `${rel} is not committed: db-query only runs reviewed, committed files.`,
    )
  }
  if (!git(['diff', '--quiet', 'HEAD', '--', rel]).ok) {
    fail(
      `${rel} differs from the committed version: commit it (for review) or discard the change.`,
    )
  }
  const blob = spawnSync('git', ['cat-file', 'blob', `HEAD:${rel}`], {
    cwd: ROOT,
  })
  if (blob.status !== 0) fail(`could not read ${rel} from HEAD`)
  return { rel, text: blob.stdout.toString('utf8'), hash: sha256(blob.stdout) }
}

if (command === 'ops-sha256') {
  // Local only (no project is touched): what db-query would ask to confirm.
  const dir = join(ROOT, OPS_DIR)
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : []
  for (const f of files) {
    const { rel, hash } = committedOpsFile(f)
    console.log(`${hash}  ${rel}`)
  }
  process.exit(0)
}

let query = null
if (command === 'db-query') {
  const { rel, text, hash } = committedOpsFile(name)
  console.log(`[lyca-deploy] db-query file: ${rel}`)
  console.log(`[lyca-deploy] sha256: ${hash}`)
  if (process.env.LYCA_DB_QUERY_SHA256 !== hash) {
    fail(
      `confirm this exact file: read it, then run again with
` + `  LYCA_DB_QUERY_SHA256=${hash}`,
    )
  }
  try {
    query = { rel, ...renderSql(text, process.env) }
  } catch (error) {
    fail(error.message)
  }
}
if (
  command === 'functions-deploy' &&
  name &&
  !/^[a-z0-9][a-z0-9-]*$/.test(name)
) {
  fail(`not a function name: ${name}`)
}
if (mutating) {
  const dirty = git([
    'status',
    '--porcelain',
    '--',
    'supabase',
    'workspaces/lyca',
    'scripts',
  ])
  if (!dirty.ok) fail('git status failed')
  if (dirty.out) {
    fail(
      `uncommitted changes under supabase/, workspaces/lyca/ or scripts/:\n${dirty.out}\ncommit or discard them first: only a commit is deployed.`,
    )
  }
  const head = git(['rev-parse', 'HEAD'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  console.log(`[lyca-deploy] commit: ${head.out} (${branch.out})`)
}
if (LYCA_PROJECT_REF === ADOBE_PRODUCTION_PROJECT_REF) {
  fail('Lyca ref equals the Adobe production ref.')
}
if (process.env.LYCA_DEPLOY_CONFIRM !== LYCA_PROJECT_REF) {
  fail(
    `this targets the hosted LYCA project (${LYCA_PROJECT_REF}). Confirm with\n` +
      `  LYCA_DEPLOY_CONFIRM=${LYCA_PROJECT_REF}`,
  )
}
console.log(
  `[lyca-deploy] TARGET PROJECT REF: ${LYCA_PROJECT_REF} (Lyca Mobile)`,
)

// --- throw-away work directory --------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'lyca-deploy-'))
const stack = join(work, 'supabase')
mkdirSync(join(stack, 'migrations'), { recursive: true })
const seen = new Set()
for (const dir of [
  join(ROOT, 'supabase', 'migrations'),
  join(ROOT, 'workspaces', 'lyca', 'migrations'),
]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    if (seen.has(file)) fail(`duplicate migration ${file}`)
    seen.add(file)
    cpSync(join(dir, file), join(stack, 'migrations', file))
  }
}
cpSync(join(ROOT, 'supabase', 'functions'), join(stack, 'functions'), {
  recursive: true,
})
// Function settings (verify_jwt) — identical to Adobe's.
const adobeConfig = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')
const functionSettings = adobeConfig.slice(adobeConfig.indexOf('[functions.'))
writeFileSync(
  join(stack, 'config.toml'),
  `project_id = "lyca-longlist-deploy"\n\n${functionSettings}`,
)

/**
 * The Supabase CLI through npm's own npx entry point, run by this same node
 * with an argument array and no shell: a file or function name is passed as
 * it is, never re-parsed (no $(...), backtick or quote expansion).
 */
function supabaseRunner() {
  const nodeDir = dirname(process.execPath)
  const npxCli = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((f) => existsSync(f))
  if (npxCli) return { file: process.execPath, prefix: [npxCli] }
  if (process.platform === 'win32') {
    fail(`npm's npx-cli.js not found next to ${process.execPath}`)
  }
  return { file: 'npx', prefix: [] }
}
const runner = supabaseRunner()

/**
 * Runs one CLI command. With `capture`, output is collected instead of shown
 * (returned as stdout / stderr, and printed by the caller, redacted).
 */
function cli(args, { capture = false } = {}) {
  const all = ['supabase', ...args, '--workdir', work]
  if (all.includes(ADOBE_PRODUCTION_PROJECT_REF)) {
    fail('refusing a command that names the Adobe production project.')
  }
  console.log(`[lyca-deploy] > npx ${all.join(' ')}`)
  const r = spawnSync(runner.file, [...runner.prefix, ...all], {
    cwd: ROOT,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ok: r.status === 0,
    stdout: capture ? (r.stdout ?? '') : '',
    stderr: capture ? (r.stderr ?? '') : '',
  }
}

let ok = false
try {
  if (!cli(['link', '--project-ref', LYCA_PROJECT_REF]).ok) {
    throw new Error('link failed')
  }
  const linked = readFileSync(
    join(stack, '.temp', 'project-ref'),
    'utf8',
  ).trim()
  if (linked !== LYCA_PROJECT_REF)
    throw new Error(`linked to ${linked}, not Lyca`)
  console.log(`[lyca-deploy] verified linked ref: ${linked}`)
  if (command === 'migration-list')
    ok = cli(['migration', 'list', '--linked']).ok
  if (command === 'db-push-dry-run')
    ok = cli(['db', 'push', '--linked', '--dry-run']).ok
  if (command === 'db-push') ok = cli(['db', 'push', '--linked']).ok
  if (command === 'db-query') {
    // The filled-in copy lives only in the work directory (removed below).
    const filled = join(work, 'query.sql')
    writeFileSync(filled, query.sql, { mode: 0o600 })
    const r = cli(['db', 'query', '--linked', '--file', filled], {
      capture: true,
    })
    rmSync(filled, { force: true })
    if (r.stdout) process.stdout.write(redact(r.stdout, query.values))
    if (r.stderr) process.stderr.write(redact(r.stderr, query.values))
    ok = r.ok
  }
  if (command === 'functions-deploy') {
    // Code before schema pays a vendor and loses the answer: refuse while any
    // migration of this checkout is missing on Lyca.
    const list = cli(['migration', 'list', '--linked'], { capture: true })
    if (!list.ok) {
      process.stderr.write(list.stderr)
      throw new Error('could not read the migration list: nothing deployed')
    }
    const missing = unappliedMigrations(list.stdout, [...seen])
    if (missing === null) {
      throw new Error('could not read the migration list: nothing deployed')
    }
    if (missing.length) {
      throw new Error(
        `Lyca has not applied ${missing.join(', ')}. Run db-push-dry-run and db-push first: nothing deployed.`,
      )
    }
    console.log(`[lyca-deploy] all ${seen.size} migrations are applied on Lyca`)
    const names = name
      ? [name]
      : readdirSync(join(stack, 'functions')).filter((f) => !f.startsWith('_'))
    ok = names.every(
      (fn) =>
        cli(['functions', 'deploy', fn, '--project-ref', LYCA_PROJECT_REF]).ok,
    )
  }
} catch (error) {
  console.error(`
[lyca-deploy] BLOCKED: ${error.message}
`)
} finally {
  cli(['unlink'])
  rmSync(work, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
