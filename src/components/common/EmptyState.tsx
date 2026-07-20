import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-2xl">
        <Icon className="size-6" />
      </div>
      <h3 className="text-foreground text-base font-medium">{title}</h3>
      {description && (
        <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      )}
      {action}
    </div>
  )
}
