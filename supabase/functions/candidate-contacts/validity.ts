// Whether a vendor itself called a value bad (HIR-528). Its own module so
// both flow.ts and contact-store.ts use the one rule (contact-store.ts cannot
// import flow.ts, which imports it).

import type { ContactKind } from './vendors.ts'

/**
 * A value its own vendor said is bad (HIR-528): a SalesQL email with status
 * "Invalid" (or a BetterContact "undeliverable"), a phone with is_valid false.
 * It does not count as found: the next vendor is asked for that kind. It is
 * never sent to the shared store (contact-store.ts, storeContactsFrom).
 */
export function isInvalid(
  kind: ContactKind,
  v: { status?: unknown; valid?: unknown } | null | undefined,
): boolean {
  if (!v) return false
  if (kind === 'phone') return v.valid === false
  const status = typeof v.status === 'string' ? v.status.toLowerCase() : ''
  return status === 'invalid' || status === 'undeliverable'
}
