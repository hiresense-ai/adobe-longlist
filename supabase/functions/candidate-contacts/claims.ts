// One paid vendor call per person and vendor at a time (HIR-528).
//
// Two recruiters, two tabs or a double click revealing the same person would
// otherwise both pay SalesQL / BetterContact. Before paying, a request claims
// (linkedin_key, vendor) in candidate_contact_claims: an insert that does
// nothing when the row exists, so exactly one request wins. The winner pays,
// saves the answer and releases the claim. A loser pays nothing: it waits for
// the claim to go (polling, up to CLAIM_WAIT_MS) and then reads the winner's
// saved answer.
//
// A claim left by a request that crashed (the worker died between claiming
// and releasing) counts as gone once it is older than CLAIM_STALE_MS, and the
// next request takes it over. A live winner never looks crashed, however slow
// its vendor or database calls are: while `pay` runs it refreshes claimed_at
// every CLAIM_REFRESH_MS (HIR-528 review), so only a claim nobody refreshes
// for 3 minutes is ever taken over.
//
// A winner that paid but could not save the answer (paid.ts, saved twice)
// keeps its claim instead of releasing it: for CLAIM_STALE_MS nobody pays
// again for that person and vendor (they wait, then get "try again").

/** A claim older than this was left by a request that died: it may be taken over. */
export const CLAIM_STALE_MS = 3 * 60_000
/** How long a request that lost the claim waits for the winner's answer (capped by the request's deadline). */
export const CLAIM_WAIT_MS = 30_000
/** How often it looks. */
export const CLAIM_POLL_MS = 1_000
/** How often the winner refreshes its claim while it runs (well inside CLAIM_STALE_MS). */
export const CLAIM_REFRESH_MS = 30_000

export type ClaimVendor = 'salesql' | 'bettercontact'

/** candidate_contact_claims, as onceAtATime needs it (claims-db.ts on Supabase). */
export interface ClaimStore {
  /**
   * Takes the claim atomically: true when this caller now holds it. A claim
   * older than `staleBefore` is removed first, so it can be taken over.
   */
  tryClaim(
    key: string,
    vendor: ClaimVendor,
    claimId: string,
    staleBefore: string,
  ): Promise<boolean>
  /** Whether a claim newer than `staleBefore` is still held. */
  held(key: string, vendor: ClaimVendor, staleBefore: string): Promise<boolean>
  /** Removes the claim, only if it is still this caller's. */
  release(key: string, vendor: ClaimVendor, claimId: string): Promise<void>
  /** Sets claimed_at to now, only if the claim is still this caller's. False when it is not. */
  refresh(key: string, vendor: ClaimVendor, claimId: string): Promise<boolean>
}

export type ClaimOutcome<T> =
  /** This request held the claim and ran `pay`. */
  | { ran: true; value: T }
  /** Another request held it. `settled`: it finished (its answer is saved) within the wait. */
  | { ran: false; settled: boolean }

export interface ClaimOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  staleMs?: number
  waitMs?: number
  pollMs?: number
  refreshMs?: number
  claimId?: string
  /** An error from `pay` after which the claim is kept (left to go stale), not released. */
  keepClaimOn?: (err: unknown) => boolean
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Runs `pay` only while holding the (person, vendor) claim; otherwise waits
 * for whoever holds it. `pay` should re-read the saved answer first: a winner
 * that finished just before this request claimed has already paid.
 */
export async function onceAtATime<T>(
  claims: ClaimStore,
  key: string,
  vendor: ClaimVendor,
  pay: () => Promise<T>,
  options: ClaimOptions = {},
): Promise<ClaimOutcome<T>> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? wait
  const staleMs = options.staleMs ?? CLAIM_STALE_MS
  const staleBefore = () => new Date(now() - staleMs).toISOString()
  const claimId = options.claimId ?? crypto.randomUUID()

  if (await claims.tryClaim(key, vendor, claimId, staleBefore())) {
    // While `pay` runs, claimed_at is refreshed: a slow call is never taken over.
    let running = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const beat = () => {
      timer = setTimeout(async () => {
        try {
          const mine = await claims.refresh(key, vendor, claimId)
          if (!mine && running) {
            console.error(
              `contact claim for ${vendor} was taken over while its call ran`,
            )
          }
        } catch {
          console.warn(`contact claim for ${vendor} not refreshed`)
        }
        if (running) beat()
      }, options.refreshMs ?? CLAIM_REFRESH_MS)
    }
    beat()
    let keep = false
    try {
      return { ran: true, value: await pay() }
    } catch (err) {
      keep = options.keepClaimOn?.(err) ?? false
      throw err
    } finally {
      running = false
      clearTimeout(timer)
      if (keep) {
        console.warn(
          `contact claim for ${vendor} kept after an unsaved answer; it expires`,
        )
      } else {
        try {
          await claims.release(key, vendor, claimId)
        } catch {
          // Left behind, it goes stale after CLAIM_STALE_MS and is taken over.
          console.warn(`contact claim for ${vendor} not released; it expires`)
        }
      }
    }
  }

  const until = now() + (options.waitMs ?? CLAIM_WAIT_MS)
  while (now() < until) {
    await sleep(options.pollMs ?? CLAIM_POLL_MS)
    if (!(await claims.held(key, vendor, staleBefore()))) {
      return { ran: false, settled: true }
    }
  }
  return { ran: false, settled: false }
}
