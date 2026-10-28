import { invokeEdgeFunction } from '@/lib/edgeFunction'

/**
 * Candidate contact lookup (email + phone). Everything goes through the
 * candidate-contacts Edge Function — the contact tables have no client RLS
 * policies, and the vendor keys live only in that function's environment.
 */

export type ContactVerdict = 'good' | 'bad'
export type ContactBadReason =
  'bounced' | 'wrong_person' | 'not_reachable' | 'no_answer'

export type ContactKind = 'email' | 'phone'

/** One email or phone. Which vendor it came from is never exposed. */
export interface ContactValueView {
  value: string
  type: string | null
  verified: boolean | null
  verdict: ContactVerdict | null
  reason: ContactBadReason | null
  /** 'store': from the shared contact store. 'vendor': found by Lyca's own
   * vendors. Never says which vendor. */
  source: 'store' | 'vendor'
  /** Whether 👍/👎 is shown: store values, and SalesQL values while
   * BetterContact has not been asked for that kind (decided server-side). */
  feedback: boolean
}

/** Per kind: is a backup search running, can one be started, has the
 * backup already been asked and found nothing usable. */
export interface ContactKindState {
  searching: boolean
  canFind: boolean
  exhausted: boolean
}

export interface CandidateContactView {
  candidateName: string
  linkedinUrl: string
  lookedUp: boolean
  error: string | null
  emails: ContactValueView[]
  phones: ContactValueView[]
  email: ContactKindState
  phone: ContactKindState
}

export async function listCandidateContacts(
  dashboardId: string,
): Promise<CandidateContactView[]> {
  const { contacts } = await invokeEdgeFunction<{
    contacts: CandidateContactView[]
  }>('candidate-contacts', { action: 'list', payload: { dashboardId } })
  return contacts
}

export async function lookupCandidateContact(input: {
  dashboardId: string
  candidateName: string
  linkedinUrl?: string | null
  mode: 'lookup' | 'backup' | 'refresh'
  /** For 'backup': which kinds to search for (email, phone or both). */
  kinds?: ContactKind[]
}): Promise<CandidateContactView | null> {
  const { contact } = await invokeEdgeFunction<{
    contact: CandidateContactView | null
  }>('candidate-contacts', { action: 'lookup', payload: input })
  return contact ?? null
}

export async function saveCandidateContactFeedback(input: {
  dashboardId: string
  candidateName: string
  linkedinUrl?: string | null
  kind: 'email' | 'phone'
  value: string
  verdict: ContactVerdict | null
  reason?: ContactBadReason | null
}): Promise<CandidateContactView | null> {
  const { contact } = await invokeEdgeFunction<{
    contact: CandidateContactView | null
  }>('candidate-contacts', { action: 'feedback', payload: input })
  return contact ?? null
}
