import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getStatusConfig } from '@/config/statusConfig'
import type { CandidateStatus } from '@/types'

/**
 * The one place a candidate status gets rendered with color. Colors always
 * come from statusConfig.ts — never hardcoded here or anywhere else.
 */
export function StatusBadge({
  status,
  className,
}: {
  status: CandidateStatus
  className?: string
}) {
  const { resolvedTheme } = useTheme()
  const config = getStatusConfig(status)
  const palette = resolvedTheme === 'dark' ? config.dark : config.light
  const Icon = config.icon

  return (
    <Badge
      variant="outline"
      className={cn('gap-1 border transition-colors duration-200', className)}
      style={{
        backgroundColor: palette.background,
        color: palette.text,
        borderColor: palette.border,
      }}
    >
      <Icon aria-hidden="true" />
      {config.label}
    </Badge>
  )
}
