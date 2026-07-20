import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ROUTES } from '@/constants'

export function RouteErrorBoundary() {
  const error = useRouteError()

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Something went wrong while loading this page.'

  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-2xl">
        <AlertTriangle className="size-7" />
      </div>
      <h1 className="text-foreground text-2xl font-semibold">
        Unexpected error
      </h1>
      <p className="text-muted-foreground max-w-md text-sm">{message}</p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" />
          Reload
        </Button>
        <Button asChild>
          <Link to={ROUTES.home}>Back to dashboards</Link>
        </Button>
      </div>
    </div>
  )
}
