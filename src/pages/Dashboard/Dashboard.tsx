import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, SearchX } from 'lucide-react'

import { useDashboards } from '@/hooks/useDashboards'
import { filterDashboards } from '@/services/dashboards.service'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { DashboardCardSkeleton } from '@/components/dashboard/DashboardCardSkeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { getErrorMessage } from '@/lib/errors'

export function Dashboard() {
  const [searchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const {
    data: dashboards,
    isLoading,
    isError,
    error,
    refetch,
  } = useDashboards()

  const filtered = useMemo(
    () => filterDashboards(dashboards ?? [], query),
    [dashboards, query],
  )

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-semibold">Dashboards</h1>
          <p className="text-muted-foreground text-sm">
            Browse hiring dashboards and track candidate status in real time.
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <DashboardCardSkeleton key={index} />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load dashboards"
          description={getErrorMessage(
            error,
            'Please check your connection and try again.',
          )}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && dashboards && dashboards.length === 0 && (
        <EmptyState
          icon={LayoutGrid}
          title="No dashboards yet"
          description="Once dashboards are uploaded, they'll show up here."
        />
      )}

      {!isLoading &&
        !isError &&
        dashboards &&
        dashboards.length > 0 &&
        filtered.length === 0 && (
          <EmptyState
            icon={SearchX}
            title="No matches found"
            description={`Nothing matches "${query}". Try a different search term.`}
          />
        )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((dashboard) => (
            <DashboardCard key={dashboard.id} dashboard={dashboard} />
          ))}
        </div>
      )}
    </div>
  )
}
