import {
  Clock,
  CalendarClock,
  CheckCircle2,
  ThumbsUp,
  XCircle,
  PauseCircle,
  Gift,
  PartyPopper,
  type LucideIcon,
} from 'lucide-react'
import type { CandidateStatus } from '@/types'

/**
 * Single source of truth for candidate status presentation. Uploaded HTML
 * dashboards never define colors themselves — this config is the only place
 * status → color mappings exist, for both the React-rendered StatusBadge and
 * the plain hex values serialized into the sandboxed iframe's bootstrap
 * script (dashboardBridge.ts). Hex values (not Tailwind classes) are
 * required because the iframe is a separate document with no access to this
 * app's Tailwind/CSS-variable setup.
 */
export interface StatusPalette {
  background: string
  text: string
  border: string
}

export interface StatusConfigEntry {
  value: CandidateStatus
  label: string
  light: StatusPalette
  dark: StatusPalette
  icon: LucideIcon
  sortOrder: number
}

export const STATUS_CONFIG: Record<CandidateStatus, StatusConfigEntry> = {
  Pending: {
    value: 'Pending',
    label: 'Pending',
    light: { background: '#F3F4F6', text: '#374151', border: '#D1D5DB' },
    dark: { background: '#1F2937', text: '#D1D5DB', border: '#374151' },
    icon: Clock,
    sortOrder: 0,
  },
  'Interview Scheduled': {
    value: 'Interview Scheduled',
    label: 'Interview Scheduled',
    light: { background: '#DBEAFE', text: '#1D4ED8', border: '#BFDBFE' },
    dark: { background: '#1E3A8A', text: '#93C5FD', border: '#1E40AF' },
    icon: CalendarClock,
    sortOrder: 1,
  },
  'Interview Completed': {
    value: 'Interview Completed',
    label: 'Interview Completed',
    light: { background: '#EDE9FE', text: '#6D28D9', border: '#DDD6FE' },
    dark: { background: '#4C1D95', text: '#C4B5FD', border: '#5B21B6' },
    icon: CheckCircle2,
    sortOrder: 2,
  },
  Selected: {
    value: 'Selected',
    label: 'Selected',
    light: { background: '#DCFCE7', text: '#15803D', border: '#BBF7D0' },
    dark: { background: '#052E16', text: '#86EFAC', border: '#166534' },
    icon: ThumbsUp,
    sortOrder: 3,
  },
  Rejected: {
    value: 'Rejected',
    label: 'Rejected',
    light: { background: '#FEE2E2', text: '#B91C1C', border: '#FECACA' },
    dark: { background: '#7F1D1D', text: '#FCA5A5', border: '#991B1B' },
    icon: XCircle,
    sortOrder: 4,
  },
  Hold: {
    value: 'Hold',
    label: 'Hold',
    light: { background: '#FEF3C7', text: '#92400E', border: '#FDE68A' },
    dark: { background: '#451A03', text: '#FCD34D', border: '#92400E' },
    icon: PauseCircle,
    sortOrder: 5,
  },
  'Offer Released': {
    value: 'Offer Released',
    label: 'Offer Released',
    light: { background: '#FFEDD5', text: '#9A3412', border: '#FED7AA' },
    dark: { background: '#431407', text: '#FDBA74', border: '#9A3412' },
    icon: Gift,
    sortOrder: 6,
  },
  Joined: {
    value: 'Joined',
    label: 'Joined',
    light: { background: '#D1FAE5', text: '#065F46', border: '#A7F3D0' },
    dark: { background: '#022C22', text: '#6EE7B7', border: '#065F46' },
    icon: PartyPopper,
    sortOrder: 7,
  },
}

/** All statuses in canonical display order. */
export const STATUS_LIST: StatusConfigEntry[] = Object.values(
  STATUS_CONFIG,
).sort((a, b) => a.sortOrder - b.sortOrder)

export function getStatusConfig(status: CandidateStatus): StatusConfigEntry {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.Pending
}

export function getStatusPalette(
  status: CandidateStatus,
  theme: 'light' | 'dark',
): StatusPalette {
  const config = getStatusConfig(status)
  return theme === 'dark' ? config.dark : config.light
}

/**
 * Plain-data (no icons/React) serialization of every status's colors, for
 * both themes — this is what gets embedded into the sandboxed iframe's
 * bootstrap script, since it has no access to lucide-react or this app's
 * CSS at all.
 */
export function serializeStatusStyles(): Record<
  CandidateStatus,
  { light: StatusPalette; dark: StatusPalette }
> {
  return Object.fromEntries(
    STATUS_LIST.map((entry) => [
      entry.value,
      { light: entry.light, dark: entry.dark },
    ]),
  ) as Record<CandidateStatus, { light: StatusPalette; dark: StatusPalette }>
}
