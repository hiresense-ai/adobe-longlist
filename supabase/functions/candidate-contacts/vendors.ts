// Contact vendors. Keys come only from this function's own environment
// (SALESQL_API_KEY / BETTERCONTACT_API_KEY — Supabase Edge Function secrets,
// supabase/functions/.env locally); they never reach the browser.
//
// SalesQL   GET  https://api-public.salesql.com/v1/persons/enrich?linkedin_url=…
//           Authorization: Bearer <key>; 200 = person, 404 = not found.
// BetterContact (asynchronous waterfall)
//           POST https://app.bettercontact.rocks/api/v2/async        -> { id }
//           GET  https://app.bettercontact.rocks/api/v2/async/{id}  -> status
//           "terminated" carries data[0].contact_email_address / _phone_number.
//           X-API-Key: <key>. A POST is NOT idempotent (re-charges).
//
// Settings (supabase/functions/.env locally, function secrets on the project):
//   SALESQL_API_KEY         SalesQL key; unset = SalesQL is skipped
//   BETTERCONTACT_API_KEY   BetterContact key; unset = BetterContact is skipped
//   BETTERCONTACT_API_URL   optional; BetterContact's API base (default
//                           https://app.bettercontact.rocks/api/v2). Only for
//                           local tests against a fake server — never set it
//                           on a hosted project.
//   SALESQL_API_URL         optional; SalesQL's API base (default
//                           https://api-public.salesql.com/v1). Same: local
//                           tests against a fake server only.
//
// A vendor's error text never carries the request (it would hold the
// LinkedIn URL): a failed call says only that the source could not be reached.

import type { DashboardCandidate } from './candidates.ts'
import { normalizePhone } from './phone.ts'

export type Vendor = 'salesql' | 'bettercontact'
/** Where a cached answer came from: a vendor, or the shared contact store (contact-store.ts). */
export type Source = Vendor | 'contact_store'

export interface ContactEmail {
  value: string
  type: string | null
  status: string | null
}

export interface ContactPhone {
  value: string
  type: string | null
  valid: boolean | null
}

export interface VendorResult {
  status: 'found' | 'not_found' | 'pending' | 'error'
  emails: ContactEmail[]
  phones: ContactPhone[]
  requestId?: string | null
  error?: string | null
  creditsUsed?: number | null
}

const TIMEOUT_MS = 20_000

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function key(name: string): string | null {
  return Deno.env.get(name)?.trim() || null
}

export function vendorConfigured(vendor: Vendor): boolean {
  return Boolean(
    key(vendor === 'salesql' ? 'SALESQL_API_KEY' : 'BETTERCONTACT_API_KEY'),
  )
}

function errorResult(message: string): VendorResult {
  return { status: 'error', emails: [], phones: [], error: message }
}

function finish(
  emails: ContactEmail[],
  phones: ContactPhone[],
  extra: Partial<VendorResult> = {},
): VendorResult {
  return {
    status: emails.length || phones.length ? 'found' : 'not_found',
    emails,
    phones,
    ...extra,
  }
}

// ---------------------------------------------------------------- SalesQL

export async function salesqlLookup(
  candidate: DashboardCandidate,
): Promise<VendorResult> {
  const apiKey = key('SALESQL_API_KEY')
  if (!apiKey) return errorResult('Contact lookup is not configured.')

  const url = new URL(`${salesqlBase()}/persons/enrich`)
  url.searchParams.set('linkedin_url', candidate.linkedinUrl)

  let res: Response
  try {
    res = await fetchWithTimeout(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
    })
  } catch {
    return errorResult(
      'Contact lookup failed: the source could not be reached.',
    )
  }

  if (res.status === 404) return finish([], [])
  if (res.status === 401 || res.status === 403)
    return errorResult('The contact source rejected the API key or plan.')
  if (res.status === 429)
    return errorResult(
      'Too many contact lookups right now — try again shortly.',
    )
  if (!res.ok) return errorResult(`Contact lookup failed (HTTP ${res.status}).`)

  let body: Record<string, unknown>
  try {
    body = await res.json()
  } catch {
    return errorResult('The contact source returned an unreadable response.')
  }

  const emails: ContactEmail[] = []
  for (const e of Array.isArray(body.emails) ? body.emails : []) {
    const value = typeof e?.email === 'string' ? e.email.trim() : ''
    if (
      !value ||
      emails.some((x) => x.value.toLowerCase() === value.toLowerCase())
    )
      continue
    emails.push({
      value,
      type: typeof e.type === 'string' ? e.type : null,
      status: typeof e.status === 'string' ? e.status : null,
    })
  }
  const phones: ContactPhone[] = []
  for (const p of Array.isArray(body.phones) ? body.phones : []) {
    const value = typeof p?.phone === 'string' ? p.phone.trim() : ''
    const id = normalizePhone(value) ?? value
    if (
      !value ||
      phones.some((x) => (normalizePhone(x.value) ?? x.value) === id)
    )
      continue
    phones.push({
      value,
      type: typeof p.type === 'string' ? p.type : null,
      valid: typeof p.is_valid === 'boolean' ? p.is_valid : null,
    })
  }
  return finish(emails, phones)
}

export const SALESQL_DEFAULT_BASE = 'https://api-public.salesql.com/v1'

/** SALESQL_API_URL (no trailing slash), or SalesQL's own API. */
export function salesqlBase(): string {
  const url = Deno.env.get('SALESQL_API_URL')?.trim().replace(/\/+$/, '')
  return url || SALESQL_DEFAULT_BASE
}

// ---------------------------------------------------------- BetterContact

export const BC_DEFAULT_BASE = 'https://app.bettercontact.rocks/api/v2'

/** BETTERCONTACT_API_URL (no trailing slash), or BetterContact's own API. */
export function betterContactBase(): string {
  const url = Deno.env.get('BETTERCONTACT_API_URL')?.trim().replace(/\/+$/, '')
  return url || BC_DEFAULT_BASE
}
const BC_POLL_EVERY_MS = 3_000
const BC_POLL_FOR_MS = 20_000

function splitName(full: string): { first: string; last: string } {
  const parts = full
    .replace(/[^\p{L}\p{M}\s'.-]/gu, ' ')
    .trim()
    .split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: parts[0] }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export type ContactKind = 'email' | 'phone'

async function bcStart(
  candidate: DashboardCandidate,
  kinds: ContactKind[],
  apiKey: string,
): Promise<Response> {
  const { first, last } = splitName(candidate.name)
  return await fetchWithTimeout(`${betterContactBase()}/async`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [
        {
          first_name: first,
          last_name: last,
          company: candidate.company ?? '',
          linkedin_url: candidate.linkedinUrl,
          custom_fields: { linkedin_key: candidate.linkedinKey },
        },
      ],
      // Only what was asked for — a phone-only search never buys an email.
      enrich_email_address: kinds.includes('email'),
      enrich_phone_number: kinds.includes('phone'),
    }),
  })
}

/** Starts a BetterContact enrichment for the given kinds and waits briefly
 * for it (~20s); if it is still running, the dashboard keeps re-checking
 * (free) until it finishes. */
export async function betterContactLookup(
  candidate: DashboardCandidate,
  kinds: ContactKind[],
): Promise<VendorResult> {
  const apiKey = key('BETTERCONTACT_API_KEY')
  if (!apiKey)
    return errorResult('The backup contact source is not configured.')

  let res: Response
  try {
    res = await bcStart(candidate, kinds, apiKey)
  } catch {
    return errorResult(
      'Backup contact search failed: the source could not be reached.',
    )
  }
  if (res.status === 401)
    return errorResult('The backup contact source rejected the API key.')
  if (res.status === 402) {
    const text = await res.text().catch(() => '')
    return errorResult(
      /add-?on|phone/i.test(text) && !/credit/i.test(text)
        ? 'Phone search is not enabled on the backup contact plan.'
        : 'The backup contact source has no credits left.',
    )
  }
  if (!res.ok)
    return errorResult(`Backup contact search failed (HTTP ${res.status}).`)

  let started: { id?: string }
  try {
    started = await res.json()
  } catch {
    return errorResult(
      'The backup contact source returned an unreadable response.',
    )
  }
  if (!started.id)
    return errorResult('The backup contact search could not be started.')

  const deadline = Date.now() + BC_POLL_FOR_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BC_POLL_EVERY_MS))
    const result = await betterContactPoll(started.id)
    if (result.status !== 'pending') return result
  }
  return { status: 'pending', emails: [], phones: [], requestId: started.id }
}

/** One status check of an earlier BetterContact request. Never re-charges. */
export async function betterContactPoll(
  requestId: string,
): Promise<VendorResult> {
  const apiKey = key('BETTERCONTACT_API_KEY')
  if (!apiKey)
    return errorResult('The backup contact source is not configured.')

  let res: Response
  try {
    res = await fetchWithTimeout(
      `${betterContactBase()}/async/${encodeURIComponent(requestId)}`,
      {
        headers: { 'X-API-Key': apiKey },
      },
    )
  } catch {
    return {
      status: 'pending',
      emails: [],
      phones: [],
      requestId,
      error: 'Backup contact check failed: the source could not be reached.',
    }
  }
  if (res.status === 401)
    return errorResult('The backup contact source rejected the API key.')
  if (res.status === 406)
    return errorResult('The backup contact search expired — search again.')
  if (res.status >= 500)
    return { status: 'pending', emails: [], phones: [], requestId }

  let body: Record<string, unknown>
  try {
    body = await res.json()
  } catch {
    return { status: 'pending', emails: [], phones: [], requestId }
  }
  if (body.status !== 'terminated')
    return { status: 'pending', emails: [], phones: [], requestId }

  const lead = (Array.isArray(body.data) ? body.data[0] : null) as Record<
    string,
    unknown
  > | null
  const emails: ContactEmail[] = []
  const phones: ContactPhone[] = []
  if (lead) {
    const email =
      typeof lead.contact_email_address === 'string'
        ? lead.contact_email_address.trim()
        : ''
    const emailStatus =
      typeof lead.contact_email_address_status === 'string'
        ? lead.contact_email_address_status
        : null
    if (
      email &&
      emailStatus !== 'undeliverable' &&
      emailStatus !== 'not_found'
    ) {
      emails.push({ value: email, type: null, status: emailStatus })
    }
    const phone =
      typeof lead.contact_phone_number === 'string'
        ? lead.contact_phone_number.trim()
        : ''
    if (phone) phones.push({ value: phone, type: 'Mobile', valid: null })
  }
  const credits =
    typeof body.credits_consumed === 'number' ? body.credits_consumed : null
  return finish(emails, phones, { requestId, creditsUsed: credits })
}
