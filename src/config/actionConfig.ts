import type { CandidateAction } from '@/types'
import type { StatusPalette } from './statusConfig'

/**
 * Single source of truth for the recruiter "Action" dropdown injected next
 * to every dashboard's own Status column. Independent of statusConfig.ts —
 * Action tracks recruiter disposition (interview/offer/reject), not
 * candidate pipeline stage or the availability tag a dashboard's own table
 * displays. Hex values (not Tailwind classes) because these also get
 * serialized into the sandboxed iframe's bootstrap script, which has no
 * access to this app's CSS.
 */
export interface ActionConfigEntry {
  value: CandidateAction
  label: string
  light: StatusPalette
  dark: StatusPalette
  sortOrder: number
}

export const ACTION_CONFIG: Record<CandidateAction, ActionConfigEntry> = {
  'Interview Reject - Adobe': {
    value: 'Interview Reject - Adobe',
    label: 'Interview Reject - Adobe',
    light: { background: '#FEE2E2', text: '#B91C1C', border: '#FECACA' },
    dark: { background: '#7F1D1D', text: '#FCA5A5', border: '#991B1B' },
    sortOrder: 0,
  },
  'Reviewed earlier (SR) - Adobe': {
    value: 'Reviewed earlier (SR) - Adobe',
    label: 'Reviewed earlier (SR) - Adobe',
    light: { background: '#F3E8FF', text: '#7E22CE', border: '#E9D5FF' },
    dark: { background: '#3B0764', text: '#D8B4FE', border: '#6B21A8' },
    sortOrder: 1,
  },
  'Reviewed earlier (TR) - Adobe': {
    value: 'Reviewed earlier (TR) - Adobe',
    label: 'Reviewed earlier (TR) - Adobe',
    light: { background: '#E0E7FF', text: '#4338CA', border: '#C7D2FE' },
    dark: { background: '#1E1B4B', text: '#A5B4FC', border: '#3730A3' },
    sortOrder: 2,
  },
  'Interview stage - Adobe': {
    value: 'Interview stage - Adobe',
    label: 'Interview stage - Adobe',
    light: { background: '#DBEAFE', text: '#1D4ED8', border: '#BFDBFE' },
    dark: { background: '#1E3A8A', text: '#93C5FD', border: '#1E40AF' },
    sortOrder: 3,
  },
  'Interview stage - HireSense': {
    value: 'Interview stage - HireSense',
    label: 'Interview stage - HireSense',
    light: { background: '#CFFAFE', text: '#0E7490', border: '#A5F3FC' },
    dark: { background: '#083344', text: '#67E8F9', border: '#155E75' },
    sortOrder: 4,
  },
  'Offer - Adobe': {
    value: 'Offer - Adobe',
    label: 'Offer - Adobe',
    light: { background: '#DCFCE7', text: '#15803D', border: '#BBF7D0' },
    dark: { background: '#052E16', text: '#86EFAC', border: '#166534' },
    sortOrder: 5,
  },
  'Offer - HireSense': {
    value: 'Offer - HireSense',
    label: 'Offer - HireSense',
    light: { background: '#D1FAE5', text: '#065F46', border: '#A7F3D0' },
    dark: { background: '#022C22', text: '#6EE7B7', border: '#065F46' },
    sortOrder: 6,
  },
}

/** All actions in canonical dropdown order. */
export const ACTION_LIST: ActionConfigEntry[] = Object.values(
  ACTION_CONFIG,
).sort((a, b) => a.sortOrder - b.sortOrder)

export function getActionConfig(
  action: CandidateAction | null | undefined,
): ActionConfigEntry | null {
  if (!action) return null
  return ACTION_CONFIG[action] ?? null
}

export function getActionPalette(
  action: CandidateAction | null | undefined,
  theme: 'light' | 'dark',
): StatusPalette | null {
  const config = getActionConfig(action)
  if (!config) return null
  return theme === 'dark' ? config.dark : config.light
}

/**
 * Plain-data serialization (no React) of every action's label and colors,
 * for both themes — embedded into the sandboxed iframe's bootstrap script
 * the same way serializeStatusStyles() is.
 */
export function serializeActionStyles(): Record<
  CandidateAction,
  { light: StatusPalette; dark: StatusPalette }
> {
  return Object.fromEntries(
    ACTION_LIST.map((entry) => [
      entry.value,
      { light: entry.light, dark: entry.dark },
    ]),
  ) as Record<CandidateAction, { light: StatusPalette; dark: StatusPalette }>
}
