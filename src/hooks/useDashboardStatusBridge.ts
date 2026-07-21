import { useEffect, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/supabase/client'
import {
  listStatusesForDashboard,
  upsertCandidateStatus,
} from '@/services/dashboardStatus.service'
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
 */
export function useDashboardStatusBridge({
  dashboardId,
  iframeRef,
}: UseDashboardStatusBridgeOptions) {
  const queryClient = useQueryClient()

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
        const statuses = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => listStatusesForDashboard(id),
        })
        queryClient.setQueryData(queryKey, statuses)
        postCurrentStatuses()
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
          toast.success(`${payload.candidateName}: status updated successfully`)
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
  }, [dashboardId, iframeRef, queryClient])
}
