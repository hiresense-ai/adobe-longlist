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
  /** Viewport space remaining below the page header (px). The frame renders
   * at max(content height, this), so a short dashboard fills the rest of
   * the screen instead of leaving page background below it; a taller
   * dashboard is unaffected. */
  minHeight?: number
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
  minHeight = 0,
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

  // Product sizing policy: fill the viewport below the header when the
  // dashboard's own content is shorter than that, otherwise grow to the
  // content. The iframe's own document never scrolls internally (the bridge
  // sizes it to its exact content height), so raising the box to minHeight
  // only ever reveals more of the iframe's own background below the
  // content — never a second scrollbar, never clipping. Fullscreen keeps
  // filling the whole screen regardless.
  const resolvedHeight = Math.max(height ?? FALLBACK_HEIGHT, minHeight)

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden data-[fullscreen]:h-svh"
      data-fullscreen={isFullscreen || undefined}
      style={isFullscreen ? undefined : { height: resolvedHeight + 'px' }}
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
