import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getActionConfig } from '@/config/actionConfig'
import type { CandidateAction } from '@/types'

/**
 * The one place a recruiter Action gets rendered with color. Colors always
 * come from actionConfig.ts — never hardcoded here or anywhere else.
 */
export function ActionBadge({
  action,
  className,
}: {
  action: CandidateAction
  className?: string
}) {
  const { resolvedTheme } = useTheme()
  const config = getActionConfig(action)
  if (!config) return null
  const palette = resolvedTheme === 'dark' ? config.dark : config.light

  return (
    <Badge
      variant="outline"
      className={cn('border transition-colors duration-200', className)}
      style={{
        backgroundColor: palette.background,
        color: palette.text,
        borderColor: palette.border,
      }}
    >
      {config.label}
    </Badge>
  )
}
