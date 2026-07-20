import { Skeleton } from '@/components/ui/skeleton'

export function DashboardCardSkeleton() {
  return (
    <div className="border-border bg-card shadow-soft flex flex-col overflow-hidden rounded-2xl border">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-1/2" />
        <div className="mt-2 flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>
    </div>
  )
}
