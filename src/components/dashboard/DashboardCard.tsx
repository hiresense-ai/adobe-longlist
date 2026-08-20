import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  BarChart3,
  LayoutDashboard,
  Pencil,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DeleteDashboardButton } from '@/components/dashboard/DeleteDashboardButton'
import { ManageAccessDialog } from '@/components/dashboard/ManageAccessDialog'
import { DashboardAnalyticsDialog } from '@/components/dashboard/DashboardAnalyticsDialog'
import { EditDashboardDialog } from '@/components/dashboard/EditDashboardDialog'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import {
  canEditDashboard,
  canManageDashboardAssignments,
  canManageDashboards,
  canViewDashboardAnalytics,
} from '@/lib/permissions'
import { formatDate } from '@/utils/date'
import type { DashboardWithThumbnail } from '@/services/dashboards.service'

export function DashboardCard({
  dashboard,
}: {
  dashboard: DashboardWithThumbnail
}) {
  const { user } = useAuth()
  // Deleting a dashboard is Super Admin only (see permissions.ts) —
  // mirrored by the dashboards_delete_super_admin RLS policy.
  const canManage = Boolean(user && canManageDashboards(user.role))
  // Manage Access: Super Admin (every dashboard) and Admin (only dashboards
  // they can see at all, which — post assignment migration — is exactly the
  // set they're assigned to; see canManageDashboardAssignments).
  const canManageAccess = Boolean(
    user && canManageDashboardAssignments(user.role),
  )
  // Dashboard Analytics: every role — Super Admin (every dashboard), Admin
  // and Viewer (only dashboards assigned to them, which is exactly the set
  // they can see at all; enforced server-side by the dashboard-analytics
  // Edge Function on every call).
  const canViewAnalytics = Boolean(user && canViewDashboardAnalytics(user.role))
  // Edit Dashboard: Super Admin (every dashboard, full field set including
  // thumbnail) and Admin (only dashboards assigned to them, name/
  // description/category only — enforced server-side by the dashboard-edit
  // Edge Function, same split as Manage Access/Analytics).
  const canEdit = Boolean(user && canEditDashboard(user.role))
  const [isManageAccessOpen, setIsManageAccessOpen] = useState(false)
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)

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
      <div className="bg-muted relative aspect-[7/3] w-full overflow-hidden">
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

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="text-foreground line-clamp-1 text-base font-semibold">
          {dashboard.title}
        </h3>
        <p className="text-muted-foreground line-clamp-2 flex-1 text-sm">
          {dashboard.description || 'No description provided.'}
        </p>

        {/* Spacing here comes only from the parent's gap-1.5 — no extra
            margin-top — so the description-to-actions gap isn't accidentally
            doubled on top of it. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-y-2">
            <span className="text-muted-foreground text-xs">
              {formatDate(dashboard.created_at)}
            </span>
            <div className="relative z-20 flex items-center gap-2">
              {canViewAnalytics && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`View analytics for ${dashboard.title}`}
                  onClick={(event) => {
                    event.preventDefault()
                    setIsAnalyticsOpen(true)
                  }}
                >
                  <BarChart3 className="size-3.5" />
                </Button>
              )}
              {canManageAccess && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Manage access to ${dashboard.title}`}
                  onClick={(event) => {
                    event.preventDefault()
                    setIsManageAccessOpen(true)
                  }}
                >
                  <Users className="size-3.5" />
                </Button>
              )}
              {canEdit && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Edit ${dashboard.title} dashboard`}
                  onClick={(event) => {
                    event.preventDefault()
                    setIsEditOpen(true)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
              {canManage && <DeleteDashboardButton dashboard={dashboard} />}
            </div>
          </div>
          {/* Primary action on its own full-width row — the icon actions
              above it can vary from zero (Viewer) to four (Super Admin), so
              this can never be crowded out of the card regardless of role. */}
          <Button asChild size="sm" className="relative z-20 box-border w-full">
            <Link to={ROUTES.dashboard(dashboard.id)}>
              Open
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>

      {canManageAccess && isManageAccessOpen && (
        <ManageAccessDialog
          dashboard={dashboard}
          open={isManageAccessOpen}
          onOpenChange={setIsManageAccessOpen}
        />
      )}
      {canViewAnalytics && isAnalyticsOpen && (
        <DashboardAnalyticsDialog
          dashboard={dashboard}
          open={isAnalyticsOpen}
          onOpenChange={setIsAnalyticsOpen}
        />
      )}
      {canEdit && isEditOpen && (
        <EditDashboardDialog
          dashboard={dashboard}
          open={isEditOpen}
          onOpenChange={setIsEditOpen}
        />
      )}
    </div>
  )
}
