export type {
  CandidateStatus,
  CandidateAction,
  UserRole,
  Database,
  Profile,
  Dashboard,
  DashboardStatus,
  DashboardStatusInsert,
  DashboardStatusUpdate,
} from './database.types'

export interface AppUser {
  id: string
  email: string
  name: string | null
  role: import('./database.types').UserRole
}

export interface ApiError {
  message: string
  code?: string
  status?: number
}

/** A row in the admin User Management table — combines auth.users + profiles. */
export interface AdminUserRow {
  id: string
  email: string
  name: string | null
  role: import('./database.types').UserRole
  createdAt: string
  lastSignInAt: string | null
  disabled: boolean
  emailConfirmed: boolean
}

/** postMessage contract between an embedded HTML dashboard (iframe) and the host app. */
export type DashboardBridgeMessage =
  | {
      type: 'longlist:status-update'
      payload: {
        dashboardId: string
        candidateName: string
        candidateEmail?: string
        status: import('./database.types').CandidateStatus
        remarks?: string
      }
    }
  | {
      type: 'longlist:action-update'
      payload: {
        dashboardId: string
        candidateName: string
        action: import('./database.types').CandidateAction | null
      }
    }
  | { type: 'longlist:ready' }
  | {
      type: 'longlist:resize'
      dashboardId: string | null
      height: number
    }
  | { type: 'longlist:modal-open' }
  | { type: 'longlist:modal-close' }
  /**
   * A file the dashboard wants saved. The iframe can't do this itself:
   * sandboxed without allow-same-origin, its object URLs are
   * `blob:null/...`, which the browser won't resolve as a download. The
   * host has a real origin, so it mints the URL and saves the file.
   */
  | {
      type: 'longlist:export-file'
      dashboardId: string | null
      filename: string
      /**
       * Raw file bytes. Preferred over `csv`: decoding to a string strips
       * a leading UTF-8 BOM, which these exports rely on for Excel to
       * detect the encoding. Sending bytes keeps the file byte-identical.
       */
      bytes?: ArrayBuffer
      /** Plain-text fallback, for a dashboard that posts its own export. */
      csv?: string
      mimeType?: string
    }

/** Messages sent from the host app down into the iframe. */
export type DashboardHostMessage =
  | {
      type: 'longlist:init-config'
      statusOrder: import('./database.types').CandidateStatus[]
      statusStyles: unknown
      actionOrder: import('./database.types').CandidateAction[]
      actionStyles: unknown
    }
  | {
      type: 'longlist:init-statuses'
      statuses: Array<{
        candidateName: string
        status: import('./database.types').CandidateStatus
        action: import('./database.types').CandidateAction | null
      }>
    }
  | { type: 'longlist:status-ack'; success: true; candidateName: string }
  | {
      type: 'longlist:status-ack'
      success: false
      candidateName: string
      error: string
    }
  | { type: 'longlist:action-ack'; success: true; candidateName: string }
  | {
      type: 'longlist:action-ack'
      success: false
      candidateName: string
      error: string
    }
  | { type: 'longlist:theme-change'; theme: 'light' | 'dark' }
  | {
      type: 'longlist:viewport-slice'
      /** The slice of the iframe's OWN coordinate space (its full content
       * height, not the outer window) that's currently visible in the
       * browser — lets the iframe reposition its fixed-position modal to
       * match the actual viewport without the outer page ever scrolling. */
      top: number
      height: number
    }
