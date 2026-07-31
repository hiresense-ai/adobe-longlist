import { MIN_PASSWORD_LENGTH } from '@/constants'

// Ambiguous glyphs are left out on purpose: a temporary password is read
// aloud or copied by hand from an admin to a colleague, and 0/O, 1/l/I are
// exactly where that goes wrong.
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SPECIALS = '!@#$%^&*?-_=+'
const ALL = LOWER + UPPER + DIGITS + SPECIALS

/** Uniform random index into `set`, via rejection sampling.
 *
 * `% set.length` on a raw byte would bias toward the earlier characters
 * whenever 256 isn't a multiple of the set size — small, but it's a
 * credential, so the bias is removed rather than reasoned about. */
function randomChar(set: string): string {
  const limit = Math.floor(256 / set.length) * set.length
  const buf = new Uint8Array(1)
  let value: number
  do {
    crypto.getRandomValues(buf)
    value = buf[0]
  } while (value >= limit)
  return set[value % set.length]
}

/**
 * A temporary password an administrator hands to a user out of band.
 *
 * Guarantees one character from each class up front so the result always
 * satisfies STRONG_PASSWORD_PATTERN, then shuffles so those four are not
 * pinned to the first four positions. Uses crypto.getRandomValues, never
 * Math.random.
 */
export function generateSecurePassword(
  length: number = MIN_PASSWORD_LENGTH + 4,
): string {
  const required = [
    randomChar(LOWER),
    randomChar(UPPER),
    randomChar(DIGITS),
    randomChar(SPECIALS),
  ]
  const size = Math.max(length, MIN_PASSWORD_LENGTH)
  const rest = Array.from({ length: size - required.length }, () =>
    randomChar(ALL),
  )
  const chars = [...required, ...rest]

  // Fisher-Yates with crypto-backed indices.
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}
