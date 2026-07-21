import { useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DashboardFrameProps {
  src: string
  title: string
  iframeRef: RefObject<HTMLIFrameElement | null>
  onLoad?: () => void
}

export function DashboardFrame({
  src,
  title,
  iframeRef,
  onLoad,
}: DashboardFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () =>
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  async function toggleFullscreen() {
    if (!containerRef.current) return

    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await containerRef.current.requestFullscreen()
    }
  }

  return (
    <div
      ref={containerRef}
      className="border-border bg-card shadow-soft relative flex h-[calc(100svh-9rem)] w-full flex-col overflow-hidden rounded-2xl border data-[fullscreen]:h-svh data-[fullscreen]:rounded-none"
      data-fullscreen={isFullscreen || undefined}
    >
      <Button
        type="button"
        size="icon"
        variant="secondary"
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        className="shadow-soft absolute top-3 right-3 z-10"
        onClick={toggleFullscreen}
      >
        {isFullscreen ? (
          <Minimize2 className="size-4" />
        ) : (
          <Maximize2 className="size-4" />
        )}
      </Button>

      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        onLoad={onLoad}
        // Deliberately no `allow-same-origin`: combined with allow-scripts
        // that would let the sandboxed HTML strip its own sandbox and reach
        // the parent's cookies/localStorage. Without it the iframe gets an
        // opaque origin, so it can never read this app's storage, and no
        // `allow-top-navigation` means it can't navigate the parent tab
        // either. No `allow-popups` — none of the dashboard templates open
        // popups, so it's dropped rather than left as unused attack surface.
        sandbox="allow-scripts allow-forms allow-modals"
        className="size-full flex-1 border-0 bg-white"
      />
    </div>
  )
}
