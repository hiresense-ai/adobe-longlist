// Shared lock-duration/expiry math for auth-login and admin-users — kept in
// one place so the two functions can't drift on what "still locked" or "how
// long" means. Pure functions only: no Supabase client, no I/O, so importing
// this adds nothing to either function's own authorization/audit logic.

export const MIN_LOCK_MINUTES = 10
export const MAX_LOCK_MINUTES = 20

/** A fresh random lock duration, chosen independently every time an account
 * locks — per spec, not a fixed value. */
export function randomLockDurationMs(): number {
  const minutes =
    MIN_LOCK_MINUTES + Math.random() * (MAX_LOCK_MINUTES - MIN_LOCK_MINUTES)
  return Math.round(minutes * 60_000)
}

/** True once `lockExpiresAt` is in the past — the account should be treated
 * as unlocked regardless of what locked_at/failed_login_attempts still say,
 * until something actually clears them. Null (no expiry recorded — e.g. a
 * lock set before this column existed) is never treated as expired: fail
 * closed, stay locked, rather than silently auto-unlocking a legacy lock
 * with no timer attached to it. */
export function isLockExpired(lockExpiresAt: string | null): boolean {
  if (!lockExpiresAt) return false
  return new Date(lockExpiresAt).getTime() <= Date.now()
}

/** Minutes remaining until `lockExpiresAt`, rounded up so nobody is ever
 * told a shorter wait than the real one (61s left reads as "2 minutes", not
 * "1"), floored at 1 so an about-to-expire lock never reads as "0 minutes". */
export function remainingLockMinutes(lockExpiresAt: string): number {
  const ms = new Date(lockExpiresAt).getTime() - Date.now()
  return Math.max(1, Math.ceil(ms / 60_000))
}

export function lockedMessage(lockExpiresAt: string): string {
  const minutes = remainingLockMinutes(lockExpiresAt)
  return `Your account is locked. Please try again after ${minutes} minute${minutes === 1 ? '' : 's'} or contact an administrator.`
}
