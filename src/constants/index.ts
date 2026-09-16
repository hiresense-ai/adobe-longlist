// Candidate status labels, colors, and ordering all live in a single place:
// src/config/statusConfig.ts (STATUS_LIST / STATUS_CONFIG). Nothing here
// duplicates that — components and the dashboard bridge import it directly.

export const ROUTES = {
  login: '/login',
  // Static "contact your administrator" notice — this portal has no email,
  // OTP, or reset-link flow. See src/pages/Login/ForgotPassword.tsx.
  forgotPassword: '/forgot-password',
  home: '/',
  dashboardPattern: '/dashboards/:id',
  dashboard: (id: string) => `/dashboards/${id}`,
  profile: '/profile',
  adminUsers: '/admin/users',
  requirements: '/requirements',
  jdAnalytics: '/jd-analytics',
  actionLogs: '/action-logs',
  notFound: '*',
} as const

export const MIN_PASSWORD_LENGTH = 12
/** At least one lowercase, one uppercase, one digit, and one special character. */
export const STRONG_PASSWORD_PATTERN =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/
export const PASSWORD_REQUIREMENTS_HINT =
  'Include an uppercase letter, a lowercase letter, a number, and a special character.'

export const STORAGE_BUCKET = 'dashboards'
export const STORAGE_FOLDER = 'dashboards'
export const THUMBNAIL_STORAGE_FOLDER = 'dashboards/thumbnails'

export const ALLOWED_THUMBNAIL_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024

export const ALLOWED_HTML_MIME_TYPES = ['text/html'] as const
export const MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024

export const ALLOWED_CSV_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'text/plain',
] as const
export const MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024

export const APP_NAME = 'Adobe Longlist'
export const APP_DESCRIPTION =
  'Secure dashboard portal for tracking and updating candidate status across hiring dashboards.'

export const QUERY_KEYS = {
  dashboards: ['dashboards'] as const,
  dashboard: (id: string) => ['dashboards', id] as const,
  dashboardStatuses: (dashboardId: string) =>
    ['dashboard-statuses', dashboardId] as const,
  candidateNotes: (dashboardId: string) =>
    ['candidate-notes', dashboardId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  adminUsers: ['admin-users'] as const,
  orphanedAuthUsers: ['admin-users', 'orphans'] as const,
  dashboardAssignments: (dashboardId: string) =>
    ['dashboard-assignments', dashboardId] as const,
  dashboardAnalytics: (dashboardId: string) =>
    ['dashboard-analytics', dashboardId] as const,
  requirements: ['requirements'] as const,
  jdAnalytics: ['jd-analytics'] as const,
  // Keyed by the full filter/sort/pagination params object: a distinct
  // params value is a distinct query (and a distinct cache entry) — the
  // same factory-key pattern as dashboard/dashboardAnalytics above, just
  // with an object instead of a single id. Typed as `unknown` (not
  // imported from actionLogs.service.ts, to avoid a constants -> services
  // dependency) — a named interface like ListActionLogsParams has no index
  // signature, so `Record<string, unknown>` would reject it here even
  // though every field is structurally fine.
  actionLogs: (params: unknown) => ['action-logs', params] as const,
}
