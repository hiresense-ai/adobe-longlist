import { cn } from '@/lib/utils'

/**
 * Adobe corporate brand mark (the red triangular "A"), rendered inline as
 * SVG so it needs no external/CDN asset and works under the app's strict
 * script/style CSP. Used in the top navigation because this portal is
 * Adobe's own recruiting workspace (already "prepared for Adobe" throughout)
 * — legitimate client branding, not impersonation.
 *
 * Colour is the Adobe brand red (#FA0F00), fixed across light/dark themes so
 * the mark reads as the real brand rather than a theme-tinted approximation.
 * To swap in an official vector asset later, drop it in src/assets and
 * replace the <path> below — every consumer sizes it via `className`.
 */
export function AdobeLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Adobe"
      className={cn('size-7 shrink-0', className)}
    >
      <path
        fill="#FA0F00"
        d="M13.966 22.624l-1.69-4.281H8.122l3.892-9.144 5.662 13.425zM8.884 1.376H0v21.248zm6.234 0H24v21.248z"
      />
    </svg>
  )
}
