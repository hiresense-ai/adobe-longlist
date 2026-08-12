#!/usr/bin/env node
/**
 * The ONLY sanctioned path for deploying anything to PRODUCTION Supabase.
 *
 * The repo is deliberately kept UNLINKED from the production project, so
 * plain `supabase db push` / `supabase functions deploy` cannot silently
 * target production — they fail without an explicit project ref. This
 * script is where that ref is spelled out, and it refuses to run unless
 * the caller proves intent by setting:
 *
 *   PROD_DEPLOY_CONFIRM=lomiqhcbjivdgophreiw
 *
 * (the production project ref itself — typing it IS the confirmation).
 *
 * Usage:
 *   PROD_DEPLOY_CONFIRM=<prod-ref> node scripts/prod-deploy.mjs db-push
 *   PROD_DEPLOY_CONFIRM=<prod-ref> node scripts/prod-deploy.mjs functions-deploy <name>
 *
 * db-push temporarily links to production for the push, then ALWAYS
 * unlinks again (even on failure) so the repo never stays linked.
 */
import { spawnSync } from 'node:child_process'

const PRODUCTION_PROJECT_REF = 'lomiqhcbjivdgophreiw'

const [, , command, ...rest] = process.argv

function fail(msg) {
  console.error(`\n[prod-deploy] BLOCKED: ${msg}\n`)
  process.exit(1)
}

function run(args, opts = {}) {
  console.log(`[prod-deploy] > supabase ${args.join(' ')}`)
  const r = spawnSync('npx', ['supabase', ...args], {
    stdio: 'inherit',
    shell: true,
    ...opts,
  })
  return r.status === 0
}

if (!command || !['db-push', 'functions-deploy'].includes(command)) {
  fail(
    'usage: node scripts/prod-deploy.mjs <db-push | functions-deploy <name>>',
  )
}

if (process.env.PROD_DEPLOY_CONFIRM !== PRODUCTION_PROJECT_REF) {
  fail(
    `this command targets the LIVE PRODUCTION Supabase project (${PRODUCTION_PROJECT_REF}).\n` +
      `To proceed you must explicitly confirm by running with:\n\n` +
      `  PROD_DEPLOY_CONFIRM=${PRODUCTION_PROJECT_REF}\n\n` +
      `If you meant to work locally instead: 'npm run local:reset' applies\n` +
      `migrations to the local stack, and functions are served automatically\n` +
      `by 'npm run local:start'. Nothing local ever needs this script.`,
  )
}

console.log(
  `\n[prod-deploy] !!! TARGETING LIVE PRODUCTION (${PRODUCTION_PROJECT_REF}) !!!\n`,
)

if (command === 'db-push') {
  // Link is required for db push; keep it scoped to this one command and
  // always unlink afterwards so the repo returns to its safe unlinked state.
  if (!run(['link', '--project-ref', PRODUCTION_PROJECT_REF])) {
    fail('supabase link failed — production untouched.')
  }
  let ok = false
  try {
    ok = run(['db', 'push', '--linked'])
  } finally {
    run(['unlink'])
  }
  if (!ok) fail('db push failed (repo re-unlinked).')
  console.log('\n[prod-deploy] production migration push complete (repo re-unlinked).')
} else {
  const name = rest[0]
  if (!name) fail('functions-deploy requires a function name.')
  const ok = run([
    'functions',
    'deploy',
    name,
    '--project-ref',
    PRODUCTION_PROJECT_REF,
  ])
  if (!ok) fail('functions deploy failed.')
  console.log(`\n[prod-deploy] production deploy of '${name}' complete.`)
}
