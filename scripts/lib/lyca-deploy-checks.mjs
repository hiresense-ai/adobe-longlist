/**
 * Pure checks for scripts/lyca-deploy.mjs, kept apart so they can be tested
 * without a Supabase CLI or a hosted project:
 *
 *   node --test scripts/lib/lyca-deploy-checks.test.mjs
 */
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** The only folder `db-query` runs SQL from (committed, reviewed files). */
export const OPS_DIR = join('workspaces', 'lyca', 'ops')

/** A file name db-query accepts: plain lower-case name, `.sql`, nothing else. */
const QUERY_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.sql$/

/** A placeholder in an ops SQL file: __NAME__, filled from env LYCA_SQL_NAME. */
const PLACEHOLDER = /__([A-Z][A-Z0-9_]*)__/g

/**
 * The applied versions in `supabase migration list` output. The CLI prints
 * JSON when its output is not a terminal (v3), a table otherwise; both are
 * read. Returns null when nothing could be read (the caller then refuses).
 */
export function appliedVersions(output) {
  const text = String(output ?? '')
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start))
      if (Array.isArray(parsed?.migrations)) {
        return new Set(
          parsed.migrations
            .map((m) => String(m?.remote ?? '').trim())
            .filter((v) => /^\d+$/.test(v)),
        )
      }
    } catch {
      // not JSON: try the table
    }
  }
  let rows = 0
  const applied = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const cells = line.split('|').map((c) => c.trim().replace(/^`|`$/g, ''))
    if (cells.length < 2) continue
    const [local, remote] = cells
    if (!/^\d*$/.test(local) || !/^\d*$/.test(remote)) continue // header
    if (!local && !remote) continue
    rows += 1
    if (remote) applied.add(remote)
  }
  return rows ? applied : null
}

/** The version of a migration file name ("20261029000001_x.sql" → "20261029000001"). */
export function versionOf(fileName) {
  return basename(fileName).split('_')[0]
}

/**
 * The local migrations the linked database has not applied. `null` when the
 * list could not be read: treat that as "refuse".
 */
export function unappliedMigrations(listOutput, localFiles) {
  const applied = appliedVersions(listOutput)
  if (!applied) return null
  return localFiles.filter((f) => !applied.has(versionOf(f))).sort()
}

/**
 * Checks a db-query argument. It must name a `.sql` file directly inside
 * OPS_DIR (by name or path), with a plain file name. Returns the absolute
 * path, or throws with the reason.
 */
export function opsQueryFile(root, arg) {
  if (!arg) throw new Error('usage: db-query <file in workspaces/lyca/ops>')
  const opsDir = resolve(root, OPS_DIR)
  const candidate =
    arg.includes('/') || arg.includes('\\') ? resolve(arg) : join(opsDir, arg)
  if (dirname(candidate) !== opsDir) {
    throw new Error(
      `db-query only runs files in ${OPS_DIR}${sep} (got ${relative(root, candidate) || candidate})`,
    )
  }
  if (!QUERY_FILE_NAME.test(basename(candidate))) {
    throw new Error(
      `db-query file names are lower-case letters, digits and "-", ending .sql (got ${basename(candidate)})`,
    )
  }
  return candidate
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** The placeholder names in an ops SQL file, each once, in order. */
export function placeholders(sql) {
  return [...new Set([...String(sql).matchAll(PLACEHOLDER)].map((m) => m[1]))]
}

/**
 * Fills every __NAME__ with env LYCA_SQL_NAME, escaped for a single-quoted
 * SQL literal (every placeholder in an ops file sits inside '...'). Throws
 * when a value is missing. Returns the SQL and the values (to redact from
 * any output).
 */
export function renderSql(sql, env) {
  const values = []
  for (const name of placeholders(sql)) {
    const value = env[`LYCA_SQL_${name}`]
    if (!value)
      throw new Error(`set LYCA_SQL_${name} (the file uses __${name}__)`)
    values.push(value)
  }
  const rendered = String(sql).replace(PLACEHOLDER, (_, name) =>
    String(env[`LYCA_SQL_${name}`]).replaceAll("'", "''"),
  )
  return { sql: rendered, values }
}

/** Replaces every filled-in value (and its escaped form) in CLI output. */
export function redact(text, values) {
  let out = String(text ?? '')
  for (const value of values) {
    if (!value) continue
    for (const form of new Set([value, value.replaceAll("'", "''")])) {
      out = out.split(form).join('[redacted]')
    }
  }
  return out
}
