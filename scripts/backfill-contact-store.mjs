#!/usr/bin/env node
/**
 * One-time copy of Lyca's already-revealed contacts into the shared contact store
 * (hiresense-ai/contact-enrichment), so every HireSense platform can reuse them.
 *
 * Reads every found answer in candidate_contact_lookups (SalesQL and BetterContact; answers that
 * came FROM the store are skipped) and every thumbs up / down in candidate_contact_feedback, and
 * sends them through the contact-enrichment API, which stores them encrypted. Safe to run again: the
 * store adds a value once and only refreshes its "last seen" date.
 *
 * Dry run by default: prints counts only, sends nothing. Add --apply to send.
 * Prints no email, phone or profile URL, ever.
 *
 * Settings (environment):
 *   SUPABASE_URL                 the Lyca project, local or remote (local: npm run lyca:env)
 *   SUPABASE_SERVICE_ROLE_KEY    that project's service role key
 *   CONTACT_ENRICHMENT_URL       e.g. http://localhost:4100
 *   CONTACT_ENRICHMENT_API_KEY   Lyca's key in the service's PLATFORM_API_KEYS
 *
 *   node scripts/backfill-contact-store.mjs            # dry run
 *   node scripts/backfill-contact-store.mjs --apply    # send
 */
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const PAGE = 1000

function setting(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`${name} is required (see the comment at the top of this script)`)
    process.exit(1)
  }
  return value
}

const supabase = createClient(setting('SUPABASE_URL'), setting('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})
const STORE_URL = setting('CONTACT_ENRICHMENT_URL').replace(/\/+$/, '')
const STORE_KEY = setting('CONTACT_ENRICHMENT_API_KEY')

/** Lyca's thumbs-down reasons as the store's. */
const STORE_REASON = { bounced: 'bounced', wrong_person: 'wrong_person', not_reachable: 'not_reachable', no_answer: 'not_reachable' }

async function readAll(table, columns, filter) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE - 1)
    if (filter) query = filter(query)
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}

async function send(path, body) {
  const res = await fetch(`${STORE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    let code = ''
    try {
      code = (await res.json())?.error?.code ?? ''
    } catch {
      // only for the message
    }
    throw new Error(`HTTP ${res.status}${code ? ` ${code}` : ''}`)
  }
}

const lookups = await readAll(
  'candidate_contact_lookups',
  'linkedin_key, linkedin_url, vendor, emails, phones',
  (q) => q.eq('status', 'found').neq('vendor', 'contact_store'),
)
const feedback = await readAll('candidate_contact_feedback', 'linkedin_key, contact_kind, contact_value, verdict, reason')

// One request per person, every vendor's values together.
const people = new Map()
for (const row of lookups) {
  const person = people.get(row.linkedin_key) ?? { url: row.linkedin_url, contacts: [] }
  for (const e of row.emails ?? []) {
    if (!e?.value?.trim()) continue
    const verified = e.status === 'Valid' || e.status === 'deliverable'
    person.contacts.push({ kind: 'email', value: e.value, vendor: row.vendor, ...(verified ? { verified: true } : {}) })
  }
  for (const p of row.phones ?? []) {
    if (!p?.value?.trim()) continue
    person.contacts.push({ kind: 'phone', value: p.value, vendor: row.vendor, ...(p.valid ? { verified: true } : {}) })
  }
  people.set(row.linkedin_key, person)
}
for (const [key, person] of people) if (!person.contacts.length) people.delete(key)

const contactCount = [...people.values()].reduce((n, p) => n + p.contacts.length, 0)
const sharedFeedback = feedback.filter((f) => people.has(f.linkedin_key))
console.log(`found answers: ${lookups.length} rows → ${people.size} people, ${contactCount} contacts`)
console.log(`thumbs up / down: ${feedback.length} (${sharedFeedback.length} on people above)`)

if (APPLY) await apply()
else console.log('dry run: nothing sent. Add --apply to send.')

async function apply() {
let saved = 0
let saveFailed = 0
for (const person of people.values()) {
  // The API takes at most 20 contacts per request.
  for (let i = 0; i < person.contacts.length; i += 20) {
    try {
      await send('/v1/contacts', { linkedin_url: person.url, contacts: person.contacts.slice(i, i + 20) })
      saved += Math.min(20, person.contacts.length - i)
    } catch (err) {
      saveFailed += 1
      console.warn(`save failed for one person: ${err.message}`)
    }
  }
}

let fbSent = 0
let fbFailed = 0
for (const f of sharedFeedback) {
  const verdict = f.verdict === 'good' ? 'good' : 'bad'
  try {
    await send('/v1/contacts/feedback', {
      linkedin_url: people.get(f.linkedin_key).url,
      kind: f.contact_kind,
      value: f.contact_value,
      verdict,
      ...(verdict === 'bad' ? { reason: STORE_REASON[f.reason] ?? 'other' } : {}),
    })
    fbSent += 1
  } catch (err) {
    fbFailed += 1
    console.warn(`feedback failed for one value: ${err.message}`)
  }
}

console.log(`sent: ${saved} contacts (${saveFailed} failed requests), ${fbSent} thumbs (${fbFailed} failed)`)
process.exitCode = saveFailed || fbFailed ? 1 : 0
}
