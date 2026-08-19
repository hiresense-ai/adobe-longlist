import { invokeEdgeFunction } from '@/lib/edgeFunction'

const FUNCTION_NAME = 'requirements'

export const REQUIREMENT_STATUSES = [
  'Pending',
  'Contacted',
  'In Progress',
  'Completed',
] as const

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

/** Minimal identity for creator/contactor display — name (may be unset)
 * and email only, same shape as DashboardAssignedUser. */
export interface RequirementUserRef {
  id: string
  name: string | null
  email: string
}

/**
 * What the requirements Edge Function returns for one requirement. The
 * shape is decided SERVER-side per role and status: a Viewer looking at
 * their own requirement after it has been contacted receives only the
 * summary fields — `hasFullDetails: false` and every optional field below
 * absent. The client never has the restricted data to hide; this type just
 * mirrors that contract.
 */
export interface Requirement {
  id: string
  title: string
  status: RequirementStatus
  createdAt: string
  createdBy: RequirementUserRef | null
  /** False exactly when the server stripped the restricted fields (Viewer
   * + post-Contacted). Everything below is only present when true. */
  hasFullDetails: boolean
  jdText?: string | null
  jdUrl?: string | null
  /** At least one entry, always — creation without a top skill is
   * rejected server-side. Full shape only, like jdText. */
  topSkills?: string[]
  optionalSkills?: string[]
  targetCompanies?: string[]
  updatedAt?: string
  contactedBy?: RequirementUserRef | null
  contactedAt?: string | null
  contactNotes?: string | null
}

export interface CreateRequirementInput {
  title: string
  jdText?: string | null
  jdUrl?: string | null
  /** Required — must contain at least one entry after trimming. */
  topSkills: string[]
  optionalSkills?: string[]
  targetCompanies?: string[]
}

export interface UpdateRequirementInput {
  requirementId: string
  title?: string
  jdText?: string | null
  jdUrl?: string | null
  /** When present, must contain at least one entry (server-enforced). */
  topSkills?: string[]
  optionalSkills?: string[]
  targetCompanies?: string[]
  /** Super Admin only — the Edge Function rejects the key outright for
   * any other caller. Omit it entirely unless editing notes. */
  contactNotes?: string | null
}

export interface UpdateRequirementStatusInput {
  requirementId: string
  status: RequirementStatus
  /** Optional notes recorded with the transition (e.g. when marking
   * Contacted). Super Admin only, like the transition itself. */
  contactNotes?: string | null
}

export async function listRequirements(): Promise<Requirement[]> {
  const { requirements } = await invokeEdgeFunction<{
    requirements: Requirement[]
  }>(FUNCTION_NAME, { action: 'list', payload: {} })
  return requirements
}

export async function createRequirement(
  input: CreateRequirementInput,
): Promise<Requirement> {
  const { requirement } = await invokeEdgeFunction<{
    requirement: Requirement
  }>(FUNCTION_NAME, { action: 'create', payload: input })
  return requirement
}

export async function updateRequirement(
  input: UpdateRequirementInput,
): Promise<Requirement> {
  const { requirementId, ...fields } = input
  const { requirement } = await invokeEdgeFunction<{
    requirement: Requirement
  }>(FUNCTION_NAME, {
    action: 'update',
    payload: { requirementId, ...fields },
  })
  return requirement
}

export async function updateRequirementStatus(
  input: UpdateRequirementStatusInput,
): Promise<Requirement> {
  const { requirement } = await invokeEdgeFunction<{
    requirement: Requirement
  }>(FUNCTION_NAME, { action: 'updateStatus', payload: input })
  return requirement
}

export async function deleteRequirement(requirementId: string): Promise<void> {
  await invokeEdgeFunction<{ ok: true }>(FUNCTION_NAME, {
    action: 'delete',
    payload: { requirementId },
  })
}

/** Client-side search over the already-authorized list — same pattern as
 * filterDashboards/filterAdminUsers. Matches title and creator name/email. */
export function filterRequirements(
  requirements: Requirement[],
  query: string,
): Requirement[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return requirements

  return requirements.filter((requirement) =>
    [
      requirement.title,
      requirement.createdBy?.name,
      requirement.createdBy?.email,
    ]
      .filter(Boolean)
      .some((field) => field!.toLowerCase().includes(normalized)),
  )
}
