// node --test scripts/lib/lyca-deploy-checks.test.mjs
//
// The checks scripts/lyca-deploy.mjs makes before it touches the Lyca project
// (HIR-526 review): functions-deploy refuses while a migration is missing,
// db-query runs only a committed file from workspaces/lyca/ops/, and filled-in
// values never reach the output.
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  appliedVersions,
  opsQueryFile,
  placeholders,
  redact,
  renderSql,
  sha256,
  unappliedMigrations,
} from './lyca-deploy-checks.mjs'

const LOCAL = [
  '20261027000001_contact_store_vendor.sql',
  '20261029000001_contact_store_sync.sql',
  '20261029000002_contact_lookup_claims.sql',
]

// `supabase migration list` (CLI 3.0.0) when its output is piped: JSON.
const JSON_ALL_APPLIED = JSON.stringify({
  migrations: [
    { local: '20261027000001', remote: '20261027000001', time: 'x' },
    { local: '20261029000001', remote: '20261029000001', time: 'x' },
    { local: '20261029000002', remote: '20261029000002', time: 'x' },
  ],
  message: 'Migrations listed',
})
const JSON_ONE_MISSING = JSON.stringify({
  migrations: [
    { local: '20261027000001', remote: '20261027000001', time: 'x' },
    { local: '20261029000001', remote: '', time: 'x' },
    { local: '20261029000002', remote: '', time: 'x' },
  ],
})
// The same as a table (terminal output; values may be in backticks).
const TABLE_ONE_MISSING = `
   Local            | Remote           | Time (UTC)
  ------------------|------------------|---------------------
   \`20261027000001\` | \`20261027000001\` | \`2026-10-27 00:00:01\`
   \`20261029000001\` |                  | \`2026-10-29 00:00:01\`
   20261029000002   |                  | 2026-10-29 00:00:02
`

test('functions-deploy goes ahead only when every local migration is applied', () => {
  assert.deepEqual(unappliedMigrations(JSON_ALL_APPLIED, LOCAL), [])
  assert.deepEqual(unappliedMigrations(JSON_ONE_MISSING, LOCAL), [
    '20261029000001_contact_store_sync.sql',
    '20261029000002_contact_lookup_claims.sql',
  ])
  assert.deepEqual(unappliedMigrations(TABLE_ONE_MISSING, LOCAL), [
    '20261029000001_contact_store_sync.sql',
    '20261029000002_contact_lookup_claims.sql',
  ])
  // Log lines before the JSON do not matter.
  assert.deepEqual(
    unappliedMigrations(
      `Connecting to remote database...\n${JSON_ALL_APPLIED}`,
      LOCAL,
    ),
    [],
  )
})

test('a migration list it cannot read refuses the deploy (null)', () => {
  assert.equal(unappliedMigrations('', LOCAL), null)
  assert.equal(unappliedMigrations('error: not logged in', LOCAL), null)
  assert.equal(appliedVersions('Local | Remote | Time'), null)
})

test('db-query takes only a plain .sql file directly in workspaces/lyca/ops', () => {
  const root = resolve('/repo')
  const ops = join(root, 'workspaces', 'lyca', 'ops')
  assert.equal(
    opsQueryFile(root, 'contact-store-sync-schedule.sql'),
    join(ops, 'contact-store-sync-schedule.sql'),
  )
  assert.equal(
    opsQueryFile(root, join(ops, 'contact-store-sync-check-job.sql')),
    join(ops, 'contact-store-sync-check-job.sql'),
  )
  for (const bad of [
    undefined,
    '',
    join(root, 'tmp', 'any.sql'), // another folder
    join(ops, '..', 'migrations', 'x.sql'), // out of the folder
    join(ops, 'sub', 'x.sql'), // a sub-folder
    'x.txt',
    '$(touch pwned).sql', // shell syntax in a name
    'a`b`.sql',
    'a".sql',
    'Upper.sql',
  ]) {
    assert.throws(() => opsQueryFile(root, bad), undefined, String(bad))
  }
})

test('placeholders are filled from LYCA_SQL_*, escaped, and must all be set', () => {
  const sql =
    "select vault.create_secret('__SYNC_SECRET__', '__FUNCTION_URL__'); -- __SYNC_SECRET__"
  assert.deepEqual(placeholders(sql), ['SYNC_SECRET', 'FUNCTION_URL'])
  const { sql: out, values } = renderSql(sql, {
    LYCA_SQL_SYNC_SECRET: "s3cr'et",
    LYCA_SQL_FUNCTION_URL: 'https://example.invalid/fn',
  })
  assert.equal(
    out,
    "select vault.create_secret('s3cr''et', 'https://example.invalid/fn'); -- s3cr''et",
  )
  assert.deepEqual(values, ["s3cr'et", 'https://example.invalid/fn'])
  assert.throws(
    () => renderSql(sql, { LYCA_SQL_SYNC_SECRET: 'x' }),
    /LYCA_SQL_FUNCTION_URL/,
  )
  // A file without placeholders is run as it is.
  assert.deepEqual(renderSql('select 1;', {}), { sql: 'select 1;', values: [] })
})

test('the CLI output never shows a filled-in value, even if it echoes the statement', () => {
  const echoed =
    "ERROR: syntax error in: select vault.create_secret('s3cr''et', 'https://example.invalid/fn')"
  const out = redact(echoed, ["s3cr'et", 'https://example.invalid/fn'])
  assert.ok(!out.includes('s3cr'), out)
  assert.ok(!out.includes('example.invalid'), out)
  assert.match(out, /\[redacted\]/)
})

test('sha256 is of the bytes given (the committed blob)', () => {
  assert.equal(sha256(Buffer.from('select 1;\n')), sha256('select 1;\n'))
  assert.notEqual(sha256('select 1;\n'), sha256('select 1;\r\n'))
})
