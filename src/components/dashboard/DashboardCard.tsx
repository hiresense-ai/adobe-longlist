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
    <div className="group border-border bg-card shadow-soft flex flex-col overflow-hidden rounded-2xl border transition-shadow hover:shadow-lg">
      <div className="bg-muted relative aspect-video w-full overflow-hidden">
        {dashboard.thumbnailUrl ? (
          <img
            src={dashboard.thumbnailUrl}
            alt=""
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
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
          <div className="flex items-center gap-2">
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
