// A paid vendor call, at most once per person and vendor, whose answer is
// never lost to a failed save (HIR-528 review).
//
// Under the (person, vendor) claim (claims.ts): re-read the saved answer
// (someone may have just paid), pay, save. The save is retried once with the
// same answer. If it still fails, the answer is lost: that is logged as an
// error with its counts only (never a value), and the claim is kept rather
// than released, so for CLAIM_STALE_MS nobody pays the vendor again for that
// person; the request answers "temporarily unavailable".
//
// index.ts runs SalesQL and BetterContact through salesqlOnce /
// betterContactOnce; the tests run the same functions against a fake vendor
// and the real claims table (claims-db_test.ts).

import {
  onceAtATime,
  type ClaimOptions,
  type ClaimOutcome,
  type ClaimStore,
} from './claims.ts'
import type { ContactKind, VendorResult } from './vendors.ts'

/** A vendor was paid and its answer could not be saved, twice. */
export class PaidAnswerNotSaved extends Error {}

/** Pause before the one retry of a failed save. */
export const SAVE_RETRY_DELAY_MS = 500

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A database error's code (or the error's name): safe to log, no row content. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  return err instanceof Error ? err.name : 'error'
}

/** What a vendor answer held, as counts only. */
export function countsOf(result: VendorResult): string {
  return `status ${result.status}, ${result.emails.length} email(s), ${result.phones.length} phone(s)`
}

/**
 * Saves a paid answer, retrying once. Throws PaidAnswerNotSaved (after an
 * error log line with the answer's counts) when both attempts fail.
 */
export async function saveWithRetry(
  label: string,
  result: VendorResult,
  save: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  try {
    await save()
    return
  } catch (first) {
    console.warn(
      `${label}: saving the paid answer failed (${codeOf(first)}), retrying once`,
    )
  }
  await sleep(SAVE_RETRY_DELAY_MS)
  try {
    await save()
    console.warn(`${label}: the paid answer was saved on the retry`)
  } catch (second) {
    console.error(
      `${label}: PAID answer NOT saved (${countsOf(result)}): ${codeOf(second)}. The claim is kept so nobody pays again until it expires.`,
    )
    throw new PaidAnswerNotSaved(`${label}: paid answer not saved`)
  }
}

const keepOnLostAnswer = (err: unknown) => err instanceof PaidAnswerNotSaved

export interface SalesqlOnceDeps {
  claims: ClaimStore
  key: string
  /**
   * The saved SalesQL answer, re-read under the claim. Non-null: it stands
   * (someone paid a moment ago), nothing is bought.
   */
  readSaved: () => Promise<VendorResult | null>
  /** The paid call. */
  lookup: () => Promise<VendorResult>
  /** Saves the answer (and sends it to the store in the background). */
  save: (result: VendorResult) => Promise<unknown>
  options?: ClaimOptions
  sleep?: (ms: number) => Promise<void>
}

/** SalesQL for one person: at most one paid call at a time, answer saved or claim kept. */
export function salesqlOnce(
  deps: SalesqlOnceDeps,
): Promise<ClaimOutcome<VendorResult>> {
  return onceAtATime(
    deps.claims,
    deps.key,
    'salesql',
    async () => {
      const saved = await deps.readSaved()
      if (saved) return saved
      const result = await deps.lookup()
      await saveWithRetry(
        'SalesQL',
        result,
        () => deps.save(result),
        deps.sleep,
      )
      return result
    },
    { ...deps.options, keepClaimOn: keepOnLostAnswer },
  )
}

/** The person's BetterContact row, as betterContactOnce needs it. */
export interface BackupState {
  status: string
  email_searched: boolean
  phone_searched: boolean
}

export interface BetterContactOnceDeps<Row extends BackupState> {
  claims: ClaimStore
  key: string
  /** The kinds the caller wants searched. */
  wanted: ContactKind[]
  /** The saved row, re-read under the claim. */
  readSaved: () => Promise<Row | null>
  /** The paid call, for the kinds still needed. */
  lookup: (kinds: ContactKind[]) => Promise<VendorResult>
  /** Saves the answer into the row. */
  save: (
    saved: Row | null,
    kinds: ContactKind[],
    result: VendorResult,
  ) => Promise<unknown>
  options?: ClaimOptions
  sleep?: (ms: number) => Promise<void>
}

/**
 * BetterContact for one person: under the claim, the kinds already searched
 * (or a search still running) are not bought again; the answer is saved, or
 * the claim kept. Returns whether a call was paid (when this request ran).
 */
export function betterContactOnce<Row extends BackupState>(
  deps: BetterContactOnceDeps<Row>,
): Promise<ClaimOutcome<boolean>> {
  return onceAtATime(
    deps.claims,
    deps.key,
    'bettercontact',
    async () => {
      const saved = await deps.readSaved()
      if (saved?.status === 'pending') return false
      const still = deps.wanted.filter((k) =>
        k === 'email' ? !saved?.email_searched : !saved?.phone_searched,
      )
      if (!still.length) return false
      const result = await deps.lookup(still)
      await saveWithRetry(
        'BetterContact',
        result,
        () => deps.save(saved, still, result),
        deps.sleep,
      )
      return true
    },
    { ...deps.options, keepClaimOn: keepOnLostAnswer },
  )
}
