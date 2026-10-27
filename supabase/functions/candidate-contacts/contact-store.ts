// The shared contact store (hiresense-ai/contact-enrichment): one place where every HireSense
// platform keeps the contacts it revealed. "Get contact" asks it first; it answers from what any
// platform already revealed, then from ZipLabs. Only when it has nothing does SalesQL run. What
// SalesQL or BetterContact find, and every thumbs up / down, is written back so no platform pays for
// the same contact twice.
//
// Settings (supabase/functions/.env locally, function secrets on the project):
//   CONTACT_ENRICHMENT_URL       e.g. http://host.docker.internal:4100 for a service on this machine
//   CONTACT_ENRICHMENT_API_KEY   Lyca's key in that service's PLATFORM_API_KEYS
// With either missing, nothing here is called and the lookup works exactly as before.

import type {
  ContactEmail,
  ContactKind,
  ContactPhone,
  VendorResult,
} from './vendors.ts'

const TIMEOUT_MS = 8_000

interface StoreContact {
  value: string
  status: 'good' | 'bad' | 'unknown'
  verified: boolean | null
}

export class ContactStoreUnavailable extends Error {}

function settings(): { url: string; key: string } | null {
  const url = Deno.env.get('CONTACT_ENRICHMENT_URL')?.trim()
  const key = Deno.env.get('CONTACT_ENRICHMENT_API_KEY')?.trim()
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null
}

export function contactStoreConfigured(): boolean {
  return settings() !== null
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const s = settings()
  if (!s) throw new ContactStoreUnavailable('not configured')
  let res: Response
  try {
    res = await fetch(`${s.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new ContactStoreUnavailable(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!res.ok) {
    let code = ''
    try {
      code =
        ((await res.json()) as { error?: { code?: string } })?.error?.code ?? ''
    } catch {
      // only for the message
    }
    throw new ContactStoreUnavailable(
      `HTTP ${res.status}${code ? ` ${code}` : ''}`,
    )
  }
  return (await res.json()) as T
}

/**
 * The store's contacts (then ZipLabs', through the store) in this function's own shape. A value
 * another platform marked bad is left out. "not_found" when there is nothing usable. Throws
 * ContactStoreUnavailable when the store can't answer, ZipLabs being down included: the caller then
 * goes on to SalesQL exactly as before.
 */
export async function contactStoreLookup(
  linkedinUrl: string,
): Promise<VendorResult> {
  const body = await post<{ emails?: StoreContact[]; phones?: StoreContact[] }>(
    '/v1/contacts/lookup',
    {
      linkedin_url: linkedinUrl,
      kinds: ['email', 'phone'],
    },
  )
  const usable = (items?: StoreContact[]) =>
    (items ?? []).filter((c) => c.status !== 'bad')
  const emails: ContactEmail[] = usable(body.emails).map((c) => ({
    value: c.value,
    type: null,
    status: c.verified === true ? 'Valid' : null,
  }))
  const phones: ContactPhone[] = usable(body.phones).map((c) => ({
    value: c.value,
    type: null,
    valid: c.verified,
  }))
  return {
    status: emails.length || phones.length ? 'found' : 'not_found',
    emails,
    phones,
  }
}

/** Saves what a vendor found, so every platform reuses it. Best-effort: logs, never throws. */
export async function contactStoreSave(
  linkedinUrl: string,
  vendor: string,
  found: { emails: ContactEmail[]; phones: ContactPhone[] },
): Promise<void> {
  if (!contactStoreConfigured()) return
  const contacts = [
    ...found.emails.map((e) => ({
      kind: 'email' as const,
      value: e.value,
      vendor,
      ...(e.status === 'Valid' || e.status === 'deliverable'
        ? { verified: true }
        : {}),
    })),
    ...found.phones.map((p) => ({
      kind: 'phone' as const,
      value: p.value,
      vendor,
      ...(p.valid ? { verified: true } : {}),
    })),
  ]
    .filter((c) => c.value?.trim())
    .slice(0, 20)
  if (!contacts.length) return
  try {
    await post('/v1/contacts', { linkedin_url: linkedinUrl, contacts })
  } catch (err) {
    console.warn(
      'contact store save skipped:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Lyca's thumbs up / down reasons as the store's. */
const STORE_REASON: Record<
  string,
  'not_reachable' | 'bounced' | 'wrong_person' | 'other'
> = {
  bounced: 'bounced',
  wrong_person: 'wrong_person',
  not_reachable: 'not_reachable',
  no_answer: 'not_reachable',
}

/** A thumbs up / down, shared with every platform. Best-effort: logs, never throws. */
export async function contactStoreFeedback(
  linkedinUrl: string,
  kind: ContactKind,
  value: string,
  verdict: 'good' | 'bad',
  reason: string | null,
): Promise<void> {
  if (!contactStoreConfigured()) return
  try {
    await post('/v1/contacts/feedback', {
      linkedin_url: linkedinUrl,
      kind,
      value,
      verdict,
      ...(verdict === 'bad'
        ? { reason: STORE_REASON[reason ?? ''] ?? 'other' }
        : {}),
    })
  } catch (err) {
    // A 404 only means the store never held this value (looked up before the store existed).
    console.warn(
      'contact store feedback skipped:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
