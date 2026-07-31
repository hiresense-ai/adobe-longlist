export function formatDate(
  value: string | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(date)
}

/** "X min" until a lock expires, rounded up and floored at 1 so an
 * about-to-expire lock never reads as "0 min" — matches the server's own
 * rounding in supabase/functions/_shared/lockout.ts's remainingLockMinutes,
 * so the admin UI and the message a locked user sees never disagree. */
export function formatRemainingLockMinutes(lockExpiresAt: string): string {
  const ms = new Date(lockExpiresAt).getTime() - Date.now()
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return `${minutes} min`
}

export function formatRelativeTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const diffMs = date.getTime() - Date.now()
  const diffSeconds = Math.round(diffMs / 1000)

  const divisions: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ]

  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })

  for (const [unit, secondsInUnit] of divisions) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return rtf.format(Math.round(diffSeconds / secondsInUnit), unit)
    }
  }
  return rtf.format(diffSeconds, 'second')
}
