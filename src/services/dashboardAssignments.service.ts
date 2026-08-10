import { invokeEdgeFunction } from '@/lib/edgeFunction'
import type { UserRole } from '@/types'

const FUNCTION_NAME = 'dashboard-assignments'

function invoke<T>(body: Record<string, unknown>): Promise<T> {
  return invokeEdgeFunction<T>(FUNCTION_NAME, body)
}

export interface DashboardAssignmentRow {
  id: string
  userId: string
  email: string | null
  name: string | null
  role: UserRole | null
  assignedAt: string
  assignedBy: string | null
}

export async function listDashboardAssignments(
  dashboardId: string,
): Promise<DashboardAssignmentRow[]> {
  const result = await invoke<{ assignments: DashboardAssignmentRow[] }>({
    action: 'list',
    payload: { dashboardId },
  })
  return result.assignments
}

export async function assignDashboardUser(
  dashboardId: string,
  userId: string,
): Promise<void> {
  await invoke({ action: 'assign', payload: { dashboardId, userId } })
}

export async function unassignDashboardUser(
  dashboardId: string,
  userId: string,
): Promise<void> {
  await invoke({ action: 'unassign', payload: { dashboardId, userId } })
}
