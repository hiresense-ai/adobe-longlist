import { Outlet, useMatch } from 'react-router-dom'
import { Navbar } from './Navbar'
import { ROUTES } from '@/constants'
import { cn } from '@/lib/utils'

export function AppLayout() {
  // The dashboard viewer opts out: it already manages its own height around
  // the uploaded dashboard's actual content (see DashboardViewer.tsx), and
  // this min-height would otherwise silently reassert the same "stretch to
  // fill the viewport" floor a short dashboard is trying to avoid — it
  // wraps every route, so a min-height here is never overridable by one
  // page beneath it. Every other route keeps it, unchanged.
  const isDashboardViewer = useMatch(ROUTES.dashboardPattern)

  return (
    <div className={cn('bg-muted/30', !isDashboardViewer && 'min-h-svh')}>
      <Navbar />
      <main className="app-container">
        <Outlet />
      </main>
    </div>
  )
}
