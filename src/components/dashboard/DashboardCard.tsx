import { Link } from 'react-router-dom'
import { ArrowUpRight, LayoutDashboard } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DeleteDashboardButton } from '@/components/dashboard/DeleteDashboardButton'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { formatDate } from '@/utils/date'
import type { DashboardWithThumbnail } from '@/services/dashboards.service'

export function DashboardCard({
  dashboard,
}: {
  dashboard: DashboardWithThumbnail
}) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  return (
    <div className="group border-border bg-card shadow-soft dark:hover:shadow-elevated hover:border-primary/30 dark:hover:border-primary/50 relative flex flex-col overflow-hidden rounded-2xl border transition-all duration-[220ms] ease-out hover:-translate-y-1.5 hover:scale-[1.02] hover:cursor-pointer hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100">
      {/* Stretched link: makes the whole card a single click/tap/keyboard
          target (GitHub/Notion/Linear-style card). It's a sibling layered
          UNDER the Delete/Open controls via z-index, not an ancestor —
          real anchors can't nest, and stacking two independent click
          targets this way means a click always resolves to exactly one
          of them, so there's no double-navigation to guard against. */}
      <Link
        to={ROUTES.dashboard(dashboard.id)}
        aria-label={`Open ${dashboard.title} dashboard`}
        className="focus-visible:ring-ring absolute inset-0 z-10 rounded-2xl focus-visible:ring-2 focus-visible:outline-none"
        onKeyDown={(event) => {
          // Native <a> activates on Enter already; Space only does that
          // for buttons, so it's wired up by hand here to match spec.
          if (event.key === ' ') {
            event.preventDefault()
            event.currentTarget.click()
          }
        }}
      />
      <div className="bg-muted relative aspect-video w-full overflow-hidden">
        {dashboard.thumbnailUrl ? (
          <img
            src={dashboard.thumbnailUrl}
            alt=""
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="from-primary/10 to-primary/5 flex size-full items-center justify-center bg-gradient-to-br">
            <LayoutDashboard className="text-primary/40 size-10" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-black/0 to-transparent" />
        {dashboard.category && (
          <Badge className="bg-background/90 text-foreground absolute top-3 left-3 border-none shadow-sm backdrop-blur">
            {dashboard.category}
          </Badge>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-5">
        <h3 className="text-foreground line-clamp-1 text-base font-semibold">
          {dashboard.title}
        </h3>
        <p className="text-muted-foreground line-clamp-2 flex-1 text-sm">
          {dashboard.description || 'No description provided.'}
        </p>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            {formatDate(dashboard.created_at)}
          </span>
          <div className="relative z-20 flex items-center gap-2">
            {isAdmin && <DeleteDashboardButton dashboard={dashboard} />}
            <Button asChild size="sm">
              <Link to={ROUTES.dashboard(dashboard.id)}>
                Open
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
