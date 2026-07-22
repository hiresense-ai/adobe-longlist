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
  | {
      type: 'longlist:modal-open'
      /** The modal content's position/size relative to the iframe's own
       * viewport (i.e. a plain getBoundingClientRect() read inside the
       * iframe) — meaningful to the host only combined with the iframe
       * element's own position in the outer document. */
      top: number
      height: number
    }
  | { type: 'longlist:modal-close' }

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
