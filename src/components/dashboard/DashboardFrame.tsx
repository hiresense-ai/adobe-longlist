import { useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DashboardFrameProps {
  src: string
  title: string
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The dashboard's own reported content height (px), or null before its
   * first report has arrived. */
  height: number | null
  onLoad?: () => void
}

// Shown only for the brief window between the iframe mounting and the
// dashboard's bridge script reporting its real height — avoids a 0-height
// flash without pretending to know the real size in advance.
const FALLBACK_HEIGHT = 600

export function DashboardFrame({
  src,
  title,
  iframeRef,
  height,
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
      className="relative w-full overflow-hidden data-[fullscreen]:h-svh"
      data-fullscreen={isFullscreen || undefined}
      // Natural height, not a fixed viewport slice: matches the dashboard's
      // own reported content size so the browser page scrolls it, rather
      // than boxing it into a fixed height with its own internal scrollbar.
      // Fullscreen overrides this via the Tailwind class above, since that
      // mode should always fill the whole screen regardless of content size.
      style={
        isFullscreen
          ? undefined
          : { height: (height ?? FALLBACK_HEIGHT) + 'px' }
      }
    >
      <Button
        type="button"
        size="icon"
        variant="secondary"
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        className="bg-background/90 absolute top-4 right-4 z-10 shadow-lg backdrop-blur-sm transition-shadow hover:shadow-xl"
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
        className="size-full border-0 bg-white"
      />
    </div>
  )
}
