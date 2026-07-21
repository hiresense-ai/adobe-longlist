import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ROUTES } from '@/constants'

export function Forbidden() {
  return (
    <div className="flex min-h-[70svh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-2xl">
        <ShieldAlert className="size-7" />
      </div>
      <p className="text-primary text-sm font-semibold tracking-wide uppercase">
        403
      </p>
      <h1 className="text-foreground text-3xl font-semibold">Unauthorized</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        You don't have permission to view this page. It's restricted to admins.
      </p>
      <Button asChild className="mt-2">
        <Link to={ROUTES.home}>Back to dashboards</Link>
      </Button>
    </div>
  )
}
