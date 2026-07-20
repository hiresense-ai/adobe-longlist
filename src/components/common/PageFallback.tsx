import { Loader2 } from 'lucide-react'

export function PageFallback() {
  return (
    <div className="bg-background flex min-h-svh items-center justify-center">
      <Loader2 className="text-primary size-8 animate-spin" />
    </div>
  )
}
