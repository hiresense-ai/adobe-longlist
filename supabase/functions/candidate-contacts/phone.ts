// One phone format for every comparison (HIR-528), exactly the shared rule of
// qa-runs/2026-10-29/reveal-audit/SHARED_CONTRACT.md (contact-enrichment and
// HireTap do the same). Default country: India (+91).
//
// Stored rows keep the vendor's own text; only comparisons use this form.

/** E.164-style `+<digits>`, or null when it is not a phone (8–15 digits after `+`). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  let out: string
  if (trimmed.startsWith('+')) {
    out = `+${digits}`
  } else if (digits.startsWith('00')) {
    out = `+${digits.slice(2)}`
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    out = `+91${digits}`
  } else if (digits.length === 11 && /^0[6-9]/.test(digits)) {
    out = `+91${digits.slice(1)}`
  } else if (digits.length === 12 && /^91[6-9]/.test(digits)) {
    out = `+${digits}`
  } else {
    out = `+${digits}`
  }
  const n = out.length - 1
  return n >= 8 && n <= 15 ? out : null
}
