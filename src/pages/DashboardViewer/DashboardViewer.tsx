import { useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, FileWarning, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { DashboardFrame } from '@/components/dashboard/DashboardFrame'
import { PoweredByHireSense } from '@/components/common/PoweredByHireSense'
import { useDashboard } from '@/hooks/useDashboard'
import { useDashboardHtml } from '@/hooks/useDashboardHtml'
import { useDashboardStatusBridge } from '@/hooks/useDashboardStatusBridge'
import { ROUTES } from '@/constants'
import { getErrorMessage } from '@/lib/errors'

export function DashboardViewer() {
  const { id } = useParams<{ id: string }>()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const {
    data: dashboard,
    isLoading: isDashboardLoading,
    isError: isDashboardError,
    error: dashboardError,
    refetch: refetchDashboard,
  } = useDashboard(id)

  const {
    blobUrl,
    isLoading: isHtmlLoading,
    error: htmlError,
    isEmpty,
    hasHireSenseBranding,
  } = useDashboardHtml(dashboard?.storage_path, dashboard?.id)

  useDashboardStatusBridge({
    dashboardId: dashboard?.id,
    iframeRef,
  })

  if (isDashboardLoading) {
    return (
      <div className="flex min-h-[60svh] items-center justify-center">
        <Loader2 className="text-primary size-8 animate-spin" />
      </div>
    )
  }

  if (isDashboardError) {
    return (
      <div className="px-4 py-8 sm:px-6 lg:px-8">
        <ErrorState
          title="Couldn't load this dashboard"
          description={getErrorMessage(
            dashboardError,
            'Please check your connection and try again.',
          )}
          onRetry={() => refetchDashboard()}
        />
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState
          icon={FileWarning}
          title="Dashboard not found"
          description="This dashboard may have been removed or the link is incorrect."
          action={
            <Button asChild size="sm" className="mt-2">
              <Link to={ROUTES.home}>
                <ArrowLeft className="size-3.5" />
                Back to dashboards
              </Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    // Fixed to exactly the viewport height left over below the navbar (h-16
    // = 4rem), split header/dashboard via flex rather than a hardcoded
    // offset for the dashboard area — so the header can wrap to whatever
    // height its own content needs (a long description, a wrapped badge)
    // without ever pushing the page into a second, outer scrollbar. Only
    // the iframe's own document scrolls internally if it's taller than the
    // space it's given, the same way a BI tool's embedded report does.
    <div className="from-background to-muted/20 flex h-[calc(100svh-4rem)] flex-col overflow-hidden bg-gradient-to-b">
      <div className="shrink-0 px-4 pt-4 pb-2 sm:px-6 lg:px-8">
        <Link
          to={ROUTES.home}
          className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-3.5" />
          Back to dashboards
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-foreground text-xl font-semibold">
            {dashboard.title}
          </h1>
          {dashboard.category && (
            <Badge variant="outline">{dashboard.category}</Badge>
          )}
        </div>
        {dashboard.description && (
          <p className="text-muted-foreground mt-1 text-sm">
            {dashboard.description}
          </p>
        )}
        {!isHtmlLoading && !htmlError && !isEmpty && !hasHireSenseBranding && (
          <PoweredByHireSense className="mt-1 inline-block" />
        )}
      </div>

      {/* Breaks out of AppLayout's max-w-7xl content column so the
          dashboard itself can span nearly the full browser width, without
          touching that shared layout — the standard full-bleed technique:
          100vw wide, then pulled back by the gap between the constrained
          container's own 50% and the true viewport 50%. */}
      <div
        className="relative min-h-0 flex-1"
        style={{
          width: '100vw',
          marginLeft: 'calc(50% - 50vw)',
          marginRight: 'calc(50% - 50vw)',
        }}
      >
        <div className="h-full px-0 sm:px-6 lg:px-10">
          {isHtmlLoading && (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-primary size-8 animate-spin" />
            </div>
          )}

          {!isHtmlLoading && htmlError && (
            <div className="px-4 py-8 sm:px-0">
              <ErrorState
                title="Couldn't load this dashboard's content"
                description={getErrorMessage(
                  htmlError,
                  'The file could not be downloaded from storage.',
                )}
              />
            </div>
          )}

          {!isHtmlLoading && !htmlError && isEmpty && (
            <div className="px-4 py-8 sm:px-0">
              <EmptyState
                icon={FileWarning}
                title="This dashboard is empty"
                description="The HTML file for this dashboard has no content."
              />
            </div>
          )}

          {!isHtmlLoading && !htmlError && !isEmpty && blobUrl && (
            <DashboardFrame
              src={blobUrl}
              title={dashboard.title}
              iframeRef={iframeRef}
            />
          )}
        </div>
      </div>
    </div>
  )
}
