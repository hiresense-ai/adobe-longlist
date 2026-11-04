// One deadline for a whole reveal request (HIR-528 review). The store lookup,
// its `pending` wait, the waits on another request's claim and the vendor
// calls used to add up to about 80 s. Now each is cut to what is left of
// REVEAL_BUDGET_MS, and a paid vendor call only starts when there is time for
// it to finish and be saved: a call that would be cut off is left for the next
// click, never paid and then lost.

/** A reveal request answers within about this long. */
export const REVEAL_BUDGET_MS = 55_000
/**
 * A paid vendor call is started only with this much left: its own 20 s
 * timeout (SalesQL, or BetterContact's start) plus saving the answer.
 */
export const VENDOR_CALL_NEEDS_MS = 25_000

export class Deadline {
  readonly #end: number
  readonly #now: () => number

  constructor(budgetMs = REVEAL_BUDGET_MS, now: () => number = Date.now) {
    this.#now = now
    this.#end = now() + budgetMs
  }

  /** Milliseconds left (never below 0). */
  left(): number {
    return Math.max(0, this.#end - this.#now())
  }

  /** `ms`, cut to what is left. */
  cap(ms: number): number {
    return Math.max(0, Math.min(ms, this.left()))
  }

  /** Whether `ms` more still fits. */
  allows(ms: number): boolean {
    return this.left() >= ms
  }
}

/** No limit (tests, and callers outside a reveal). */
export const NO_DEADLINE = new Deadline(Number.MAX_SAFE_INTEGER / 2)
