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
 *   functions-deploy [name]   deploy one / every Edge Function
 *
 * Every command runs in a throw-away work directory assembled from the same
 * sources as the local Lyca stack (supabase/migrations + workspaces/lyca/
 * migrations, supabase/functions), linked to the Lyca ref only for the
 * command and always unlinked afterwards. The repo's own supabase/ and
 * workspaces/lyca/ directories are never linked.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
]
if (!commands.includes(command)) {
  fail(`usage: node scripts/lyca-deploy.mjs <${commands.join(' | ')}>`)
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

function cli(args) {
  const all = ['supabase', ...args, '--workdir', work]
  if (all.includes(ADOBE_PRODUCTION_PROJECT_REF)) {
    fail('refusing a command that names the Adobe production project.')
  }
  console.log(`[lyca-deploy] > npx ${all.join(' ')}`)
  const r = spawnSync('npx', all, { cwd: ROOT, stdio: 'inherit', shell: true })
  return r.status === 0
}

let ok = false
try {
  if (!cli(['link', '--project-ref', LYCA_PROJECT_REF])) {
    throw new Error('link failed')
  }
  const linked = readFileSync(
    join(stack, '.temp', 'project-ref'),
    'utf8',
  ).trim()
  if (linked !== LYCA_PROJECT_REF)
    throw new Error(`linked to ${linked}, not Lyca`)
  console.log(`[lyca-deploy] verified linked ref: ${linked}`)
  if (command === 'migration-list') ok = cli(['migration', 'list', '--linked'])
  if (command === 'db-push-dry-run')
    ok = cli(['db', 'push', '--linked', '--dry-run'])
  if (command === 'db-push') ok = cli(['db', 'push', '--linked'])
  if (command === 'functions-deploy') {
    const names = name
      ? [name]
      : readdirSync(join(stack, 'functions')).filter((f) => !f.startsWith('_'))
    ok = names.every((fn) =>
      cli(['functions', 'deploy', fn, '--project-ref', LYCA_PROJECT_REF]),
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
