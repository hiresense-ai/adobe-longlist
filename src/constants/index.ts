import type { CandidateStatus } from '@/types'

export const CANDIDATE_STATUS_OPTIONS: CandidateStatus[] = [
  'Pending',
  'Interview Scheduled',
  'Interview Completed',
  'Selected',
  'Rejected',
  'Hold',
  'Offer Released',
  'Joined',
]

export const STATUS_BADGE_STYLES: Record<CandidateStatus, string> = {
  Pending: 'bg-muted text-muted-foreground border-border',
  'Interview Scheduled':
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  'Interview Completed':
    'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-900',
  Selected:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  Rejected:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900',
  Hold: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
  'Offer Released':
    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-900',
  Joined:
    'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-900',
}

export const ROUTES = {
  login: '/login',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  home: '/',
  dashboardPattern: '/dashboards/:id',
  dashboard: (id: string) => `/dashboards/${id}`,
  profile: '/profile',
  adminUsers: '/admin/users',
  notFound: '*',
} as const

export const MIN_PASSWORD_LENGTH = 8
/** At least one lowercase, one uppercase, one digit. */
export const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/

export const STORAGE_BUCKET = 'dashboards'
export const STORAGE_FOLDER = 'dashboards'
export const THUMBNAIL_STORAGE_FOLDER = 'dashboards/thumbnails'

export const ALLOWED_THUMBNAIL_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024

export const APP_NAME = 'Adobe Longlist'
export const APP_DESCRIPTION =
  'Secure dashboard portal for tracking and updating candidate status across hiring dashboards.'

export const QUERY_KEYS = {
  dashboards: ['dashboards'] as const,
  dashboard: (id: string) => ['dashboards', id] as const,
  dashboardStatuses: (dashboardId: string) =>
    ['dashboard-statuses', dashboardId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  adminUsers: ['admin-users'] as const,
}
