// One phone format for every comparison (HIR-528), exactly the shared rule in
// contact-enrichment's docs/PHONE.md (HireTap does the same). Default country:
// India (+91).
//   1. Keep the digits; note whether the trimmed input started with "+".
//   2. It did: "+" and the digits.
//   3. It didn't: "00…" drops the "00"; 10 digits starting 6–9 become "+91"
//      and those digits; 11 digits, "0" then 10 starting 6–9, become "+91" and
//      the last 10; 12 digits, "91" then 6–9, become "+" and the digits;
//      anything else becomes "+" and the digits.
//   4. Fewer than 8 digits, or more than 15, is not a phone.
//   5. A result starting "+0" is not a phone (no country code starts with 0).
//   6. A result starting "+91" is a phone only with 12 digits in all.
//
// Stored rows keep the vendor's own text; only comparisons use this form. A
// value the rule refuses is not a phone at all: never kept, shown or counted
// as found (vendors.ts, flow.ts).

/** E.164-style `+<digits>`, or null when it is not a phone (rules 4–6 above). */
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
  if (n < 8 || n > 15) return null
  if (out.startsWith('+0')) return null
  if (out.startsWith('+91') && n !== 12) return null
  return out
}
