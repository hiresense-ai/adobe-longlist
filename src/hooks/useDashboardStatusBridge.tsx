import { useEffect, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { supabase } from '@/supabase/client'
import {
  listStatusesForDashboard,
  upsertCandidateAction,
  upsertCandidateStatus,
} from '@/services/dashboardStatus.service'
import { StatusBadge } from '@/components/status/StatusBadge'
import { ActionBadge } from '@/components/status/ActionBadge'
import { STATUS_LIST, serializeStatusStyles } from '@/config/statusConfig'
import { ACTION_LIST, serializeActionStyles } from '@/config/actionConfig'
import { QUERY_KEYS } from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import type { DashboardBridgeMessage, DashboardStatus } from '@/types'

interface UseDashboardStatusBridgeOptions {
  dashboardId: string | undefined
  iframeRef: RefObject<HTMLIFrameElement | null>
}

/**
 * Wires an embedded dashboard's postMessage bridge to Supabase:
 * - relays each candidate's persisted status into the iframe once it's ready
 * - saves status changes as they happen and acks success/failure back down
 * - keeps the iframe in sync when another user updates a status, via Realtime
 * - tells the iframe which theme is active so it can color its native
 *   status selects from the same statusConfig this app uses (colors are
 *   computed here, in React — the iframe only ever applies what it's told)
 * - tracks the dashboard's own reported content height (longlist:resize),
 *   so the host can size the iframe to fit it instead of giving it a fixed
 *   height and letting it scroll internally
 */
export function useDashboardStatusBridge({
  dashboardId,
  iframeRef,
}: UseDashboardStatusBridgeOptions) {
  const queryClient = useQueryClient()
  const { resolvedTheme } = useTheme()
  const [iframeHeight, setIframeHeight] = useState<number | null>(null)

  // Resets the reported height when switching to a different dashboard, so
  // it doesn't briefly render the new iframe at the previous one's height
  // before it reports its own. Adjusting state during render (React's
  // sanctioned pattern for "reset state when a prop changes") rather than
  // in an effect, which would cause an extra, avoidable re-render.
  const [heightForId, setHeightForId] = useState(dashboardId)
  if (dashboardId !== heightForId) {
    setHeightForId(dashboardId)
    setIframeHeight(null)
  }

  useEffect(() => {
    if (!dashboardId) return
    const id = dashboardId

    const queryKey = QUERY_KEYS.dashboardStatuses(id)

    function postToIframe(message: unknown) {
      iframeRef.current?.contentWindow?.postMessage(message, '*')
    }

    function postCurrentStatuses() {
      const list = queryClient.getQueryData<DashboardStatus[]>(queryKey) ?? []
      postToIframe({
        type: 'longlist:init-statuses',
        statuses: list.map((s) => ({
          candidateName: s.candidate_name,
          status: s.status,
          action: s.action,
        })),
      })
    }

    async function handleMessage(event: MessageEvent) {
      // Checking event.source (not event.origin) is deliberate: the iframe
      // is sandboxed without allow-same-origin, so its origin is opaque
      // ("null") and can't be string-matched. Comparing the message's
      // source window object to this exact iframe's contentWindow is
      // actually the stronger check — it rejects messages from any other
      // window (e.g. a page that opened this tab via window.open and tried
      // to forge a status-update message), not just ones with a mismatched
      // origin string.
      if (
        !iframeRef.current?.contentWindow ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return
      }

      const data = event.data as DashboardBridgeMessage | undefined
      if (!data || typeof data !== 'object') return

      if (data.type === 'longlist:ready') {
        postToIframe({
          type: 'longlist:init-config',
          statusOrder: STATUS_LIST.map((s) => s.value),
          statusStyles: serializeStatusStyles(),
          actionOrder: ACTION_LIST.map((a) => a.value),
          actionStyles: serializeActionStyles(),
        })

        const statuses = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => listStatusesForDashboard(id),
        })
        queryClient.setQueryData(queryKey, statuses)
        postCurrentStatuses()
        postToIframe({
          type: 'longlist:theme-change',
          theme: resolvedTheme === 'dark' ? 'dark' : 'light',
        })
        return
      }

      if (data.type === 'longlist:status-update') {
        const { payload } = data
        if (payload.dashboardId !== id) return

        try {
          const updated = await upsertCandidateStatus(payload)
          queryClient.setQueryData<DashboardStatus[]>(queryKey, (prev) => {
            const rest = (prev ?? []).filter((s) => s.id !== updated.id)
            return [...rest, updated]
          })
          postToIframe({
            type: 'longlist:status-ack',
            success: true,
            candidateName: payload.candidateName,
          })
          toast.success(
            <span className="flex items-center gap-1.5">
              {payload.candidateName}
              <span className="text-muted-foreground">→</span>
              <StatusBadge status={payload.status} />
            </span>,
          )
        } catch (error) {
          const message = getErrorMessage(error, 'Failed to save status')
          postToIframe({
            type: 'longlist:status-ack',
            success: false,
            candidateName: payload.candidateName,
            error: message,
          })
          toast.error(`Couldn't update ${payload.candidateName}'s status`, {
            description: message,
          })
        }
      }

      if (data.type === 'longlist:resize') {
        setIframeHeight(data.height)
        return
      }

      if (data.type === 'longlist:action-update') {
        const { payload } = data
        if (payload.dashboardId !== id) return

        try {
          const updated = await upsertCandidateAction(payload)
          queryClient.setQueryData<DashboardStatus[]>(queryKey, (prev) => {
            const rest = (prev ?? []).filter((s) => s.id !== updated.id)
            return [...rest, updated]
          })
          postToIframe({
            type: 'longlist:action-ack',
            success: true,
            candidateName: payload.candidateName,
          })
          if (payload.action) {
            toast.success(
              <span className="flex items-center gap-1.5">
                {payload.candidateName}
                <span className="text-muted-foreground">→</span>
                <ActionBadge action={payload.action} />
              </span>,
            )
          }
        } catch (error) {
          const message = getErrorMessage(error, 'Failed to save action')
          postToIframe({
            type: 'longlist:action-ack',
            success: false,
            candidateName: payload.candidateName,
            error: message,
          })
          toast.error(`Couldn't update ${payload.candidateName}'s action`, {
            description: message,
          })
        }
      }
    }

    window.addEventListener('message', handleMessage)

    const channel = supabase
      .channel(`dashboard-status-${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dashboard_status',
          filter: `dashboard_id=eq.${id}`,
        },
        (change) => {
          queryClient.setQueryData<DashboardStatus[]>(queryKey, (prev) => {
            const list = prev ?? []

            if (change.eventType === 'DELETE') {
              const removed = change.old as Partial<DashboardStatus>
              return list.filter((s) => s.id !== removed.id)
            }

            const incoming = change.new as DashboardStatus
            const rest = list.filter((s) => s.id !== incoming.id)
            return [...rest, incoming]
          })
          postCurrentStatuses()
        },
      )
      .subscribe()

    return () => {
      window.removeEventListener('message', handleMessage)
      supabase.removeChannel(channel)
    }
  }, [dashboardId, iframeRef, queryClient, resolvedTheme])

  // Theme can change independently of any bridge message (user toggles the
  // app's theme while a dashboard is already open) — push it down live so
  // colors adapt instantly without an iframe reload.
  useEffect(() => {
    if (!dashboardId) return
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'longlist:theme-change',
        theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      },
      '*',
    )
  }, [resolvedTheme, dashboardId, iframeRef])

  return { iframeHeight }
}
