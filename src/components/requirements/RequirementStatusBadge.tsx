import { Badge } from '@/components/ui/badge'
import type { RequirementStatus } from '@/services/requirements.service'

/** One badge style per workflow stage, using the same inline light/dark
 * Tailwind palette pattern as the Users table's role/status badges. */
const STATUS_BADGE_CLASSES: Record<RequirementStatus, string> = {
  Pending:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
  Contacted:
    'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300',
  'In Progress':
    'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300',
  Completed:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
}

export function RequirementStatusBadge({
  status,
}: {
  status: RequirementStatus
}) {
  return (
    <Badge variant="outline" className={STATUS_BADGE_CLASSES[status]}>
      {status}
    </Badge>
  )
}
