// The contact flow's decisions (HIR-491), kept free of I/O so they can be
// tested on their own:
//
//   "Get contact" -> the shared contact store first. For each kind (email,
//                    phone) the store has nothing for, Lyca's own vendors run
//                    straight away, no click: SalesQL, then BetterContact for
//                    whatever SalesQL did not find. Every answer and every
//                    👍/👎 goes back to the store.
//   "Find another" -> offered for a kind only after a 👎 on a contact the
//                    STORE gave, when nothing usable of that kind is left and
//                    a vendor not yet asked for it remains. Never after a 👎
//                    on a contact a vendor found: the vendors already tried.

import type { ContactKind } from './vendors.ts'

export interface Found {
  emails: Array<{ value: string }>
  phones: Array<{ value: string }>
}

/** The kinds, from those asked, that `found` has no value for. */
export function kindsMissing(
  found: Found | null,
  kinds: ContactKind[],
): ContactKind[] {
  return kinds.filter(
    (kind) =>
      !(found ? (kind === 'email' ? found.emails : found.phones) : []).length,
  )
}

/** How a value is compared: emails ignore case, phones are taken as stored. */
export function contactId(kind: ContactKind, value: string): string {
  return kind === 'email' ? value.trim().toLowerCase() : value.trim()
}

export interface FindAnotherInput {
  kind: ContactKind
  /** Every value of this kind shown, with the workspace's verdict. */
  items: Array<{ value: string; verdict: 'good' | 'bad' | null }>
  /** Values of this kind the shared contact store gave. */
  storeValues: Set<string>
  /** SalesQL has already been asked for this person (an answer, not an error). */
  salesqlAsked: boolean
  /** BetterContact has already been asked for this kind. */
  backupAsked: boolean
  salesqlReady: boolean
  backupReady: boolean
}

/** Whether "Find another email / number" is offered for this kind. */
export function canFindAnother(input: FindAnotherInput): boolean {
  const badFromStore = input.items.some(
    (item) =>
      item.verdict === 'bad' &&
      input.storeValues.has(contactId(input.kind, item.value)),
  )
  if (!badFromStore) return false
  if (input.items.some((item) => item.verdict !== 'bad')) return false
  const vendorLeft =
    (input.salesqlReady && !input.salesqlAsked) ||
    (input.backupReady && !input.backupAsked)
  return vendorLeft
}
