import { useEffect, useState } from 'react'
import { downloadDashboardHtml } from '@/supabase/storage'
import { injectBridgeScript } from '@/lib/dashboardBridge'

interface UseDashboardHtmlResult {
  blobUrl: string | null
  isLoading: boolean
  error: Error | null
  isEmpty: boolean
}

interface Result {
  key: string
  blobUrl: string | null
  error: Error | null
  isEmpty: boolean
}

/** Downloads a dashboard's HTML from Storage, injects the status bridge script, and exposes it as a blob: URL for a sandboxed iframe. */
export function useDashboardHtml(
  storagePath: string | undefined,
  dashboardId: string | undefined,
): UseDashboardHtmlResult {
  const key = storagePath && dashboardId ? `${dashboardId}:${storagePath}` : ''
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    if (!storagePath || !dashboardId) return

    let cancelled = false
    let objectUrl: string | null = null

    downloadDashboardHtml(storagePath)
      .then((html) => {
        if (cancelled) return

        if (!html.trim()) {
          setResult({ key, blobUrl: null, error: null, isEmpty: true })
          return
        }

        const withBridge = injectBridgeScript(html, dashboardId)
        const blob = new Blob([withBridge], { type: 'text/html' })
        objectUrl = URL.createObjectURL(blob)
        setResult({ key, blobUrl: objectUrl, error: null, isEmpty: false })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setResult({
          key,
          blobUrl: null,
          error:
            err instanceof Error ? err : new Error('Failed to load dashboard'),
          isEmpty: false,
        })
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [storagePath, dashboardId, key])

  const isCurrent = result?.key === key

  return {
    blobUrl: isCurrent ? result.blobUrl : null,
    isLoading: !isCurrent,
    error: isCurrent ? result.error : null,
    isEmpty: isCurrent ? result.isEmpty : false,
  }
}
