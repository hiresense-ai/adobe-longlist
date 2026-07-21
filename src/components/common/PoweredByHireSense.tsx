import { cn } from '@/lib/utils'

/**
 * Subtle "technology provider" attribution. Adobe Longlist is the product;
 * HireSense.ai only ever appears here, small and muted, never as the
 * primary brand.
 */
export function PoweredByHireSense({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground/60 text-[11px] leading-tight',
        className,
      )}
    >
      Powered by HireSense.ai
    </span>
  )
}
