import { Outlet, useMatch } from 'react-router-dom'
import { Navbar } from './Navbar'
import { ROUTES } from '@/constants'
import { cn } from '@/lib/utils'
import { IS_LOCAL_BACKEND } from '@/supabase/client'

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
      {/* Dev-only backend indicator (import.meta.env.DEV compiles out of
          production builds). Makes it immediately obvious which Supabase
          backend this dev server is talking to; the client.ts guard already
          refuses production outright, so in practice this reads LOCAL. */}
      {import.meta.env.DEV && (
        <div
          className={cn(
            'fixed bottom-2 left-2 z-50 rounded-md px-2 py-1 font-mono text-xs font-semibold shadow',
            IS_LOCAL_BACKEND
              ? 'bg-emerald-600 text-white'
              : 'bg-red-600 text-white',
          )}
        >
          {IS_LOCAL_BACKEND ? 'Environment: LOCAL' : 'Environment: REMOTE'}
        </div>
      )}
    </div>
  )
}
