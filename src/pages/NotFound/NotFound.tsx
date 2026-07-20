import { Link } from 'react-router-dom'
import { Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ROUTES } from '@/constants'

export function NotFound() {
  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-primary text-sm font-semibold tracking-wide uppercase">
        404
      </p>
      <h1 className="text-foreground text-3xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        The page you're looking for doesn't exist or may have been moved.
      </p>
      <Button asChild className="mt-2">
        <Link to={ROUTES.home}>
          <Home className="size-4" />
          Back to dashboards
        </Link>
      </Button>
    </div>
  )
}
