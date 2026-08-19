// Requirements (job requirement / JD submissions) — server-side only.
//
// Mirrors dashboard-assignments' shape (caller identity + role verified
// from a real session before anything runs; service-role client only
// reached after that; every mutation rate-limited and audit-logged). The
// requirements table has deny-all RLS (see its migration), so this
// function is the ONLY path to the data — which is what makes the
// field-level viewer rule actually enforceable:
//
// Workflow (order is fixed): Pending → Contacted → In Progress → Completed
//
//   super_admin — sees everything at every stage; the only role that can
//                 change status (including reopening/correcting); edits
//                 any requirement and its contact notes; the only role
//                 that can delete (matching the dashboards delete policy).
//   admin       — sees EVERY requirement in FULL at every stage (JD, URL,
//                 contact info, contact notes); may edit title/JD fields
//                 only while status = 'Pending'; never touches status or
//                 contact notes.
//   viewer      — sees ONLY their own requirements. Full details while
//                 'Pending'; once contacted, the response contains ONLY
//                 summary fields (title/status/creator/created date) —
//                 jd_text, jd_url, contact_notes, contacted_by and
//                 contacted_at are stripped server-side and never reach
//                 the client. May edit own 'Pending' rows only.
//
// contacted_by/contacted_at are always derived from the verified caller
// session at the moment of the Pending → Contacted transition — never
// accepted from the request body.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Same allowlist as admin-users/dashboard-assignments — defense-in-depth
// only, the real gate is the JWT + role check below regardless of origin.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://adobe-longlist.vercel.app',
  'https://longlist.hiresense.ai',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed =
    ALLOWED_ORIGINS.has(origin) ||
    (origin.endsWith('.vercel.app') && origin.includes('adobe-longlist'))

  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(
  body: unknown,
  status = 200,
  cors: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

const MAX_BODY_BYTES = 64_000
const MAX_TITLE_LENGTH = 200
const MAX_JD_TEXT_LENGTH = 20_000
const MAX_JD_URL_LENGTH = 2_048
const MAX_CONTACT_NOTES_LENGTH = 2_000
const MAX_LIST_ITEMS = 50
const MAX_LIST_VALUE_LENGTH = 100
const RATE_LIMIT_WINDOW_MINUTES = 10
const RATE_LIMIT_MAX_ACTIONS = 60

const STATUSES = ['Pending', 'Contacted', 'In Progress', 'Completed'] as const
type RequirementStatus = (typeof STATUSES)[number]

type CallerRole = 'super_admin' | 'admin' | 'viewer'

interface CreatePayload {
  title: string
  jdText?: string | null
  jdUrl?: string | null
  topSkills?: unknown
  optionalSkills?: unknown
  targetCompanies?: unknown
}
interface GetPayload {
  requirementId: string
}
interface UpdatePayload {
  requirementId: string
  title?: string
  jdText?: string | null
  jdUrl?: string | null
  contactNotes?: string | null
  topSkills?: unknown
  optionalSkills?: unknown
  targetCompanies?: unknown
}
interface UpdateStatusPayload {
  requirementId: string
  status: RequirementStatus
  contactNotes?: string | null
}
interface DeletePayload {
  requirementId: string
}

type ActionBody =
  | { action: 'list'; payload?: Record<never, never> }
  | { action: 'get'; payload: GetPayload }
  | { action: 'create'; payload: CreatePayload }
  | { action: 'update'; payload: UpdatePayload }
  | { action: 'updateStatus'; payload: UpdateStatusPayload }
  | { action: 'delete'; payload: DeletePayload }

type SupabaseClient = ReturnType<typeof createClient>

interface ProfileRef {
  id: string
  name: string | null
  email: string
}

interface ListEntryRow {
  skill?: string
  company?: string
  position: number
}

interface RequirementRow {
  id: string
  title: string
  jd_text: string | null
  jd_url: string | null
  status: RequirementStatus
  created_by: string
  contacted_by: string | null
  contacted_at: string | null
  contact_notes: string | null
  created_at: string
  updated_at: string
  creator: ProfileRef | null
  contactor: ProfileRef | null
  top_skills: ListEntryRow[]
  optional_skills: ListEntryRow[]
  target_companies: ListEntryRow[]
}

const ROW_SELECT =
  'id, title, jd_text, jd_url, status, created_by, contacted_by, contacted_at, contact_notes, created_at, updated_at, ' +
  'creator:profiles!requirements_created_by_fkey(id, name, email), ' +
  'contactor:profiles!requirements_contacted_by_fkey(id, name, email), ' +
  'top_skills:requirement_top_skills(skill, position), ' +
  'optional_skills:requirement_optional_skills(skill, position), ' +
  'target_companies:requirement_target_companies(company, position)'

/** Embedded child rows arrive unordered — restore the entry order the
 * user created the chips in. */
function orderedValues(entries: ListEntryRow[] | null | undefined): string[] {
  return [...(entries ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.skill ?? entry.company ?? '')
    .filter(Boolean)
}

/**
 * THE field-level visibility rule. A viewer looking at their own
 * requirement gets the full shape only while it is still 'Pending';
 * afterwards the restricted fields are simply absent from the response —
 * not nulled, not hidden client-side, absent. Admin and Super Admin
 * always get the full shape.
 */
function shapeRequirement(row: RequirementRow, callerRole: CallerRole) {
  const summary = {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.creator
      ? { id: row.creator.id, name: row.creator.name, email: row.creator.email }
      : null,
    hasFullDetails: false,
  }

  if (callerRole === 'viewer' && row.status !== 'Pending') {
    return summary
  }

  return {
    ...summary,
    hasFullDetails: true,
    jdText: row.jd_text,
    jdUrl: row.jd_url,
    // The three lists ride with the FULL shape only — a Viewer's
    // post-Contacted summary omits them exactly like jd_text/jd_url.
    topSkills: orderedValues(row.top_skills),
    optionalSkills: orderedValues(row.optional_skills),
    targetCompanies: orderedValues(row.target_companies),
    updatedAt: row.updated_at,
    contactedBy: row.contactor
      ? {
          id: row.contactor.id,
          name: row.contactor.name,
          email: row.contactor.email,
        }
      : null,
    contactedAt: row.contacted_at,
    contactNotes: row.contact_notes,
  }
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401, cors)
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const userAgent = req.headers.get('user-agent') ?? 'unknown'

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser()

  if (callerError || !caller) {
    return json({ error: 'Invalid session' }, 401, cors)
  }

  const { data: callerProfile, error: callerProfileError } = await callerClient
    .from('profiles')
    .select('role, force_password_change')
    .eq('id', caller.id)
    .maybeSingle()

  const callerRole = callerProfile?.role as CallerRole | undefined

  if (callerProfileError || !callerRole) {
    return json({ error: 'Forbidden' }, 403, cors)
  }

  if (callerProfile?.force_password_change) {
    return json(
      {
        error: 'You must change your password before performing this action.',
      },
      403,
      cors,
    )
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body too large' }, 413, cors)
  }

  let body: ActionBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors)
  }

  const isMutation = body.action !== 'list' && body.action !== 'get'
  if (isMutation && (await isRateLimited(admin, caller.id))) {
    return json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      429,
      cors,
    )
  }

  const request = { ip, userAgent }

  try {
    switch (body.action) {
      case 'list':
        return await listRequirements(admin, caller.id, callerRole, cors)
      case 'get':
        return await getRequirement(
          admin,
          body.payload,
          caller.id,
          callerRole,
          cors,
        )
      case 'create':
        return await createRequirement(
          admin,
          body.payload,
          caller.id,
          callerRole,
          request,
          cors,
        )
      case 'update':
        return await updateRequirement(
          admin,
          body.payload,
          caller.id,
          callerRole,
          request,
          cors,
        )
      case 'updateStatus':
        return await updateRequirementStatus(
          admin,
          body.payload,
          caller.id,
          callerRole,
          request,
          cors,
        )
      case 'delete':
        return await deleteRequirement(
          admin,
          body.payload,
          caller.id,
          callerRole,
          request,
          cors,
        )
      default:
        return json({ error: 'Unknown action' }, 400, cors)
    }
  } catch (err) {
    console.error('requirements error:', err)
    const message = err instanceof Error ? err.message : 'Internal error'
    return json({ error: message }, 500, cors)
  }
})

async function isRateLimited(
  admin: SupabaseClient,
  callerId: string,
): Promise<boolean> {
  const since = new Date(
    Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000,
  ).toISOString()
  const { count, error } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('actor_id', callerId)
    .like('action', 'requirement.%')
    .gte('created_at', since)

  if (error) {
    console.error('rate limit check failed:', error)
    return false // fail open — a logging hiccup shouldn't block legitimate work
  }
  return (count ?? 0) >= RATE_LIMIT_MAX_ACTIONS
}

async function logAudit(
  admin: SupabaseClient,
  entry: {
    actorId: string
    action: string
    targetId?: string
    metadata?: Record<string, unknown>
    success: boolean
  },
) {
  const { error } = await admin.from('audit_logs').insert({
    actor_id: entry.actorId,
    action: entry.action,
    target_type: 'requirement',
    target_id: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    success: entry.success,
  })
  if (error) console.error('audit log insert failed:', error)
}

async function fetchRequirement(
  admin: SupabaseClient,
  requirementId: string,
): Promise<RequirementRow | null> {
  const { data, error } = await admin
    .from('requirements')
    .select(ROW_SELECT)
    .eq('id', requirementId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as RequirementRow) ?? null
}

// ---------------------------------------------------------------------------
// Field validation shared by create/update. Returns the normalized value or
// an error string. Empty strings normalize to null so "cleared the field"
// and "left it blank" behave identically.
// ---------------------------------------------------------------------------

function normalizeTitle(value: unknown): { title?: string; error?: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Requirement title is required.' }
  }
  const title = value.trim()
  if (title.length > MAX_TITLE_LENGTH) {
    return { error: 'Requirement title is too long.' }
  }
  return { title }
}

function normalizeJdText(value: unknown): {
  jdText?: string | null
  error?: string
} {
  if (value === null || value === undefined) return { jdText: null }
  if (typeof value !== 'string') return { error: 'Invalid job description.' }
  const jdText = value.trim()
  if (!jdText) return { jdText: null }
  if (jdText.length > MAX_JD_TEXT_LENGTH) {
    return { error: 'Job description is too long.' }
  }
  return { jdText }
}

function normalizeJdUrl(value: unknown): {
  jdUrl?: string | null
  error?: string
} {
  if (value === null || value === undefined) return { jdUrl: null }
  if (typeof value !== 'string') return { error: 'Invalid JD link.' }
  const jdUrl = value.trim()
  if (!jdUrl) return { jdUrl: null }
  if (jdUrl.length > MAX_JD_URL_LENGTH) {
    return { error: 'JD link is too long.' }
  }
  if (!/^https?:\/\//i.test(jdUrl)) {
    return { error: 'JD link must start with http:// or https://.' }
  }
  return { jdUrl }
}

function normalizeContactNotes(value: unknown): {
  contactNotes?: string | null
  error?: string
} {
  if (value === null || value === undefined) return { contactNotes: null }
  if (typeof value !== 'string') return { error: 'Invalid contact notes.' }
  const contactNotes = value.trim()
  if (!contactNotes) return { contactNotes: null }
  if (contactNotes.length > MAX_CONTACT_NOTES_LENGTH) {
    return { error: 'Contact notes are too long.' }
  }
  return { contactNotes }
}

/**
 * Normalizes a chip list (top skills / optional skills / target
 * companies): trims every entry, drops empties, dedupes
 * case-insensitively keeping the first occurrence's casing (" React " and
 * "react" collapse to one "React"-cased entry), and bounds size. Absent
 * key → empty list; whether empty is acceptable is the caller's rule
 * (top skills: no, the other two: yes).
 */
function normalizeList(
  value: unknown,
  label: string,
): { items?: string[]; error?: string } {
  if (value === null || value === undefined) return { items: [] }
  if (!Array.isArray(value)) return { error: `Invalid ${label}.` }
  const items: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return { error: `Invalid ${label}.` }
    const item = entry.trim()
    if (!item) continue
    if (item.length > MAX_LIST_VALUE_LENGTH) {
      return {
        error: `Each ${label} entry must be ${MAX_LIST_VALUE_LENGTH} characters or fewer.`,
      }
    }
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  if (items.length > MAX_LIST_ITEMS) {
    return { error: `Too many ${label} entries (max ${MAX_LIST_ITEMS}).` }
  }
  return { items }
}

const LIST_TABLES = {
  topSkills: { table: 'requirement_top_skills', column: 'skill' },
  optionalSkills: { table: 'requirement_optional_skills', column: 'skill' },
  targetCompanies: { table: 'requirement_target_companies', column: 'company' },
} as const

type ListKey = keyof typeof LIST_TABLES

/** Writes one list wholesale: clear, then insert in entry order. Used for
 * both create (clear is a no-op) and update (replace). */
async function replaceList(
  admin: SupabaseClient,
  requirementId: string,
  key: ListKey,
  values: string[],
): Promise<void> {
  const { table, column } = LIST_TABLES[key]
  const { error: deleteError } = await admin
    .from(table)
    .delete()
    .eq('requirement_id', requirementId)
  if (deleteError) throw deleteError
  if (values.length === 0) return
  const rows = values.map((value, position) => ({
    requirement_id: requirementId,
    [column]: value,
    position,
  }))
  const { error } = await admin.from(table).insert(rows)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function listRequirements(
  admin: SupabaseClient,
  callerId: string,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  let query = admin
    .from('requirements')
    .select(ROW_SELECT)
    .order('created_at', { ascending: false })

  // Viewer isolation happens HERE, in the query itself — a viewer's list
  // never even fetches other users' rows, so there is nothing to leak.
  if (callerRole === 'viewer') {
    query = query.eq('created_by', callerId)
  }

  const { data, error } = await query
  if (error) return json({ error: error.message }, 400, cors)

  const requirements = ((data ?? []) as unknown as RequirementRow[]).map(
    (row) => shapeRequirement(row, callerRole),
  )
  return json({ requirements }, 200, cors)
}

async function getRequirement(
  admin: SupabaseClient,
  payload: GetPayload,
  callerId: string,
  callerRole: CallerRole,
  cors: Record<string, string>,
) {
  const { requirementId } = payload ?? ({} as GetPayload)
  if (!requirementId) {
    return json({ error: 'requirementId is required.' }, 400, cors)
  }

  const row = await fetchRequirement(admin, requirementId)
  // A viewer asking about someone else's requirement gets the same 404 as
  // a nonexistent id — no confirmation the row exists at all.
  if (!row || (callerRole === 'viewer' && row.created_by !== callerId)) {
    return json({ error: 'Requirement not found.' }, 404, cors)
  }

  return json({ requirement: shapeRequirement(row, callerRole) }, 200, cors)
}

async function createRequirement(
  admin: SupabaseClient,
  payload: CreatePayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const p = payload ?? ({} as CreatePayload)

  const { title, error: titleError } = normalizeTitle(p.title)
  if (titleError) return json({ error: titleError }, 400, cors)
  const { jdText, error: jdTextError } = normalizeJdText(p.jdText)
  if (jdTextError) return json({ error: jdTextError }, 400, cors)
  const { jdUrl, error: jdUrlError } = normalizeJdUrl(p.jdUrl)
  if (jdUrlError) return json({ error: jdUrlError }, 400, cors)

  if (!jdText && !jdUrl) {
    return json(
      { error: 'Provide a job description, a JD link, or both.' },
      400,
      cors,
    )
  }

  const { items: topSkills, error: topSkillsError } = normalizeList(
    p.topSkills,
    'top skills',
  )
  if (topSkillsError) return json({ error: topSkillsError }, 400, cors)
  // The one required list — enforced HERE, not just in the form, so a
  // hand-crafted request with topSkills: [] (or all-blank entries) is
  // rejected the same way the UI rejects it.
  if (!topSkills || topSkills.length === 0) {
    return json({ error: 'Add at least one top skill.' }, 400, cors)
  }
  const { items: optionalSkills, error: optionalSkillsError } = normalizeList(
    p.optionalSkills,
    'optional skills',
  )
  if (optionalSkillsError) {
    return json({ error: optionalSkillsError }, 400, cors)
  }
  const { items: targetCompanies, error: targetCompaniesError } = normalizeList(
    p.targetCompanies,
    'target companies',
  )
  if (targetCompaniesError) {
    return json({ error: targetCompaniesError }, 400, cors)
  }

  // Status is not read from the payload at all: every requirement starts
  // life as 'Pending', created by the verified caller — for every role.
  const { data, error } = await admin
    .from('requirements')
    .insert({
      title,
      jd_text: jdText,
      jd_url: jdUrl,
      status: 'Pending',
      created_by: callerId,
    })
    .select('id')
    .single()

  if (error) return json({ error: error.message }, 400, cors)
  const requirementId = (data as { id: string }).id

  // One logical operation: if any child insert fails, the parent row is
  // removed again (cascade clears whatever children DID land), so a
  // requirement never exists half-created. Same compensating-cleanup
  // approach as uploadDashboard's partial-Storage cleanup.
  try {
    await replaceList(admin, requirementId, 'topSkills', topSkills)
    await replaceList(admin, requirementId, 'optionalSkills', optionalSkills!)
    await replaceList(admin, requirementId, 'targetCompanies', targetCompanies!)
  } catch (childError) {
    await admin.from('requirements').delete().eq('id', requirementId)
    throw childError
  }

  const row = await fetchRequirement(admin, requirementId)
  if (!row) return json({ error: 'Internal error' }, 500, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'requirement.created',
    targetId: row.id,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      title: row.title,
      callerRole,
    },
    success: true,
  })

  return json({ requirement: shapeRequirement(row, callerRole) }, 200, cors)
}

async function updateRequirement(
  admin: SupabaseClient,
  payload: UpdatePayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const p = payload ?? ({} as UpdatePayload)
  if (!p.requirementId) {
    return json({ error: 'requirementId is required.' }, 400, cors)
  }

  // Status never rides along on an update — not even for Super Admin.
  // Transitions have exactly one entry point (updateStatus), so there is
  // exactly one place transition rules can be checked or audited.
  if (Object.prototype.hasOwnProperty.call(p, 'status')) {
    return json(
      { error: 'Status cannot be changed through an edit.' },
      403,
      cors,
    )
  }

  const row = await fetchRequirement(admin, p.requirementId)
  if (!row || (callerRole === 'viewer' && row.created_by !== callerId)) {
    return json({ error: 'Requirement not found.' }, 404, cors)
  }

  if (callerRole !== 'super_admin') {
    // Admin and Viewer are read-only from Contacted onward.
    if (row.status !== 'Pending') {
      return json(
        {
          error:
            'This requirement has been contacted and can no longer be edited.',
        },
        403,
        cors,
      )
    }
    // Contact notes belong to the Super Admin lifecycle — a hand-crafted
    // request carrying the key at all is rejected outright, same
    // key-presence rule as dashboard-edit's thumbnail protection.
    if (Object.prototype.hasOwnProperty.call(p, 'contactNotes')) {
      return json(
        { error: 'Only a Super Admin can edit contact notes.' },
        403,
        cors,
      )
    }
  }

  const updates: Record<string, string | null> = {}

  if (Object.prototype.hasOwnProperty.call(p, 'title')) {
    const { title, error } = normalizeTitle(p.title)
    if (error) return json({ error }, 400, cors)
    updates.title = title!
  }
  if (Object.prototype.hasOwnProperty.call(p, 'jdText')) {
    const { jdText, error } = normalizeJdText(p.jdText)
    if (error) return json({ error }, 400, cors)
    updates.jd_text = jdText ?? null
  }
  if (Object.prototype.hasOwnProperty.call(p, 'jdUrl')) {
    const { jdUrl, error } = normalizeJdUrl(p.jdUrl)
    if (error) return json({ error }, 400, cors)
    updates.jd_url = jdUrl ?? null
  }
  if (
    callerRole === 'super_admin' &&
    Object.prototype.hasOwnProperty.call(p, 'contactNotes')
  ) {
    const { contactNotes, error } = normalizeContactNotes(p.contactNotes)
    if (error) return json({ error }, 400, cors)
    updates.contact_notes = contactNotes ?? null
  }

  // Chip lists — validated up front so nothing is written unless every
  // provided list is acceptable. Editability follows the exact same gates
  // as the fields above (already enforced before this point).
  const listChanges: Partial<Record<ListKey, string[]>> = {}
  for (const key of [
    'topSkills',
    'optionalSkills',
    'targetCompanies',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(p, key)) continue
    const label =
      key === 'topSkills'
        ? 'top skills'
        : key === 'optionalSkills'
          ? 'optional skills'
          : 'target companies'
    const { items, error } = normalizeList(p[key], label)
    if (error) return json({ error }, 400, cors)
    if (key === 'topSkills' && (!items || items.length === 0)) {
      return json({ error: 'Add at least one top skill.' }, 400, cors)
    }
    listChanges[key] = items!
  }

  if (
    Object.keys(updates).length === 0 &&
    Object.keys(listChanges).length === 0
  ) {
    return json({ error: 'No editable fields were provided.' }, 400, cors)
  }

  // The DB check enforces this too, but failing early gives a clean
  // message instead of a constraint error.
  const nextJdText = 'jd_text' in updates ? updates.jd_text : row.jd_text
  const nextJdUrl = 'jd_url' in updates ? updates.jd_url : row.jd_url
  if (!nextJdText && !nextJdUrl) {
    return json(
      { error: 'A requirement must keep a job description or a JD link.' },
      400,
      cors,
    )
  }

  // A list-only edit still touches the parent row so the updated_at
  // trigger stamps it (the trigger overwrites this value with now()).
  if (Object.keys(updates).length === 0) {
    updates.updated_at = new Date().toISOString()
  }

  const { error } = await admin
    .from('requirements')
    .update(updates)
    .eq('id', row.id)

  if (error) return json({ error: error.message }, 400, cors)

  for (const [key, values] of Object.entries(listChanges)) {
    await replaceList(admin, row.id, key as ListKey, values)
  }

  const updated = await fetchRequirement(admin, row.id)
  if (!updated) return json({ error: 'Internal error' }, 500, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'requirement.updated',
    targetId: row.id,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      title: updated.title,
      fields: [
        ...Object.keys(updates).filter((field) => field !== 'updated_at'),
        ...Object.keys(listChanges),
      ],
      callerRole,
    },
    success: true,
  })

  return json({ requirement: shapeRequirement(updated, callerRole) }, 200, cors)
}

async function updateRequirementStatus(
  admin: SupabaseClient,
  payload: UpdateStatusPayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const p = payload ?? ({} as UpdateStatusPayload)
  if (!p.requirementId) {
    return json({ error: 'requirementId is required.' }, 400, cors)
  }

  // The entire lifecycle after creation belongs to Super Admin — Admin and
  // Viewer get the same refusal for every transition, forward or backward.
  if (callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can change a requirement status.' },
      403,
      cors,
    )
  }

  if (!STATUSES.includes(p.status)) {
    return json({ error: 'Invalid status.' }, 400, cors)
  }

  const row = await fetchRequirement(admin, p.requirementId)
  if (!row) return json({ error: 'Requirement not found.' }, 404, cors)

  if (row.status === p.status) {
    // The state asked for already holds — idempotent no-op success, the
    // same convention as dashboard-assignments' re-assign.
    return json({ requirement: shapeRequirement(row, callerRole) }, 200, cors)
  }

  const updates: Record<string, string | null> = { status: p.status }

  // Entering Contacted records who contacted and when — derived from the
  // verified session, never from the request body. First contact only: a
  // Super Admin reopening and re-contacting keeps the original stamp as
  // the audit record of the actual first contact.
  if (p.status === 'Contacted' && !row.contacted_by) {
    updates.contacted_by = callerId
    updates.contacted_at = new Date().toISOString()
  }

  if (Object.prototype.hasOwnProperty.call(p, 'contactNotes')) {
    const { contactNotes, error } = normalizeContactNotes(p.contactNotes)
    if (error) return json({ error }, 400, cors)
    updates.contact_notes = contactNotes ?? null
  }

  const { data, error } = await admin
    .from('requirements')
    .update(updates)
    .eq('id', row.id)
    .select(ROW_SELECT)
    .single()

  if (error) return json({ error: error.message }, 400, cors)
  const updated = data as unknown as RequirementRow

  await logAudit(admin, {
    actorId: callerId,
    action: 'requirement.status_changed',
    targetId: row.id,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      title: updated.title,
      from: row.status,
      to: p.status,
      callerRole,
    },
    success: true,
  })

  return json({ requirement: shapeRequirement(updated, callerRole) }, 200, cors)
}

async function deleteRequirement(
  admin: SupabaseClient,
  payload: DeletePayload,
  callerId: string,
  callerRole: CallerRole,
  request: { ip: string; userAgent: string },
  cors: Record<string, string>,
) {
  const { requirementId } = payload ?? ({} as DeletePayload)
  if (!requirementId) {
    return json({ error: 'requirementId is required.' }, 400, cors)
  }

  // Super Admin only — the same split as dashboard deletion, and it keeps
  // Admin/Viewer from sidestepping the post-Contacted lock by deleting and
  // recreating a requirement.
  if (callerRole !== 'super_admin') {
    return json(
      { error: 'Only a Super Admin can delete a requirement.' },
      403,
      cors,
    )
  }

  const row = await fetchRequirement(admin, requirementId)
  if (!row) return json({ error: 'Requirement not found.' }, 404, cors)

  const { error } = await admin
    .from('requirements')
    .delete()
    .eq('id', requirementId)
  if (error) return json({ error: error.message }, 400, cors)

  await logAudit(admin, {
    actorId: callerId,
    action: 'requirement.deleted',
    targetId: requirementId,
    metadata: {
      ip: request.ip,
      userAgent: request.userAgent,
      title: row.title,
      status: row.status,
      callerRole,
    },
    success: true,
  })

  return json({ ok: true }, 200, cors)
}
