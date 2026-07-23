import { useLayoutEffect, useRef, useState } from 'react'
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
  const fullBleedRef = useRef<HTMLDivElement>(null)
  const [minAvailableHeight, setMinAvailableHeight] = useState(0)

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

  const { iframeHeight } = useDashboardStatusBridge({
    dashboardId: dashboard?.id,
    iframeRef,
  })

  // Sizing policy (a product decision, not a workaround): a short dashboard
  // should fill the rest of the viewport below the navbar and this page's
  // own breadcrumb/title block, rather than leaving that space as plain
  // page background — DashboardFrame takes the max() of this and the
  // dashboard's own reported content height, so a long dashboard is
  // completely unaffected. Measured live rather than a hardcoded
  // viewport-minus-navbar constant because the title block's own height
  // varies with the title/description/category badge — a fixed calc()
  // would over- or under-reserve depending on what a given dashboard's
  // title happens to wrap to.
  useLayoutEffect(() => {
    function measure() {
      if (!fullBleedRef.current) return
      const top = fullBleedRef.current.getBoundingClientRect().top
      setMinAvailableHeight(Math.max(0, window.innerHeight - top))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [
    dashboard?.title,
    dashboard?.description,
    dashboard?.category,
    isHtmlLoading,
    htmlError,
    isEmpty,
    hasHireSenseBranding,
  ])

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
    // Normal document flow, not a fixed viewport-height box: the browser
    // page itself owns scrolling, growing to whatever height the dashboard
    // actually needs — no min-height here, deliberately: AppLayout omits
    // its own min-h-svh for this route specifically so a short dashboard's
    // page can end right after its content instead of always reserving a
    // near-full-viewport floor (see AppLayout.tsx). A min-height here alone
    // would silently reintroduce the same gap AppLayout is opting out of.
    <div className="from-background to-muted/20 bg-gradient-to-b">
      <div className="px-4 pt-4 pb-2 sm:px-6 lg:px-8">
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
        ref={fullBleedRef}
        className="relative"
        style={{
          width: '100vw',
          marginLeft: 'calc(50% - 50vw)',
          marginRight: 'calc(50% - 50vw)',
        }}
      >
        <div className="px-6 lg:px-8">
          {isHtmlLoading && (
            <div className="flex min-h-[400px] items-center justify-center">
              <Loader2 className="text-primary size-8 animate-spin" />
            </div>
          )}

          {!isHtmlLoading && htmlError && (
            <div className="py-8">
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
            <div className="py-8">
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
              height={iframeHeight}
              minHeight={minAvailableHeight}
            />
          )}
        </div>
      </div>
    </div>
  )
}
