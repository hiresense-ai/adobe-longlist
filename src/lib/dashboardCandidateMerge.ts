// Core logic for appending new candidates (from a CSV) into an existing
// "Talent Landscape" dashboard HTML file, without regenerating or otherwise
// touching anything else in that file.
//
// Why this works at all: the dashboard's Candidate Explorer isn't static
// HTML rows — every dashboard in this family embeds one JSON blob
// (`window.__D = {...}`, containing `meta`, `market`, `candidates[]`, `cap`)
// in a single <script> tag, and the *rest* of the page's JS (render(),
// apply(), openDetail(), exportCSV(), the charts, the experience-range
// slider bounds, the "X of Y candidates match" counters, etc.) all read
// live from that array. So "append a candidate" only ever means "add one
// more object to window.__D.candidates" — the table, filters, modal,
// sorting, and CSV export already do the rest automatically, unchanged.
//
// This never re-serializes the whole blob (which could subtly reformat
// numbers/strings compared to how the original Python-side generator wrote
// them). It finds the exact byte offset of the candidates array's closing
// `]` and splices new candidate objects in right before it — every other
// byte of the file, including all existing candidates, the CSS, and every
// other <script>, is copied through untouched. This is verified before
// returning: the merged output is re-parsed and checked to prove every
// existing candidate is byte-identical and nothing outside the insertion
// point moved, or an error is thrown instead of returning a bad result.
//
// Shared by two callers:
//   - scripts/merge-dashboard-candidates.mjs (a local CLI for testing
//     against a downloaded HTML file + CSV before uploading)
//   - src/services/dashboardAdmin.service.ts (the "Update Candidates"
//     admin feature, which downloads the HTML from Supabase Storage and
//     runs the exact same logic in the browser)

export interface FieldSpec {
  key: string
  type: 'string' | 'number' | 'boolean' | 'json'
  default: unknown
  aliases?: string[]
}

// CSV columns (case/spacing-insensitive; unrecognized columns are ignored
// rather than invented into new fields). `rank` is always assigned by this
// module (existing candidates keep theirs; new ones get the next unused
// integers), since it's also the row/detail-modal lookup key and must stay
// unique — it is deliberately not a CSV-mappable field.
export const FIELD_SPECS: FieldSpec[] = [
  { key: 'name', type: 'string', default: '' },
  { key: 'tag', type: 'string', default: 'Active', aliases: ['status'] },
  { key: 'fit', type: 'number', default: null },
  { key: 'fit_band', type: 'string', default: null, aliases: ['fit band'] },
  {
    key: 'yrs',
    type: 'number',
    default: null,
    aliases: ['years', 'experience', 'yoe', 'years of experience'],
  },
  {
    key: 'loc',
    type: 'string',
    default: '',
    aliases: ['location', 'metro', 'city'],
  },
  {
    key: 'loc_full',
    type: 'string',
    default: '',
    aliases: ['location full', 'full location'],
  },
  {
    key: 'company',
    type: 'string',
    default: '',
    aliases: ['employer', 'current company'],
  },
  {
    key: 'headline',
    type: 'string',
    default: '',
    aliases: ['title', 'current title', 'job title'],
  },
  {
    key: 'li_url',
    type: 'string',
    default: '',
    aliases: ['linkedin', 'linkedin url', 'linkedin profile', 'li url'],
  },
  { key: 'email', type: 'string', default: '', aliases: ['email address'] },
  {
    key: 'candidate_id',
    type: 'string',
    default: '',
    aliases: ['candidateid', 'candidate id', 'id'],
  },
  {
    key: 'github',
    type: 'string',
    default: '',
    aliases: ['github url', 'github profile'],
  },
  { key: 'product', type: 'string', default: '', aliases: ['product company'] },
  {
    key: 'premier',
    type: 'boolean',
    default: false,
    aliases: ['premier institute'],
  },
  { key: 'arch', type: 'string', default: '' },
  { key: 'recency', type: 'number', default: null },
  { key: 'last_active', type: 'string', default: '', aliases: ['last active'] },
  {
    key: 'notice',
    type: 'number',
    default: null,
    aliases: ['notice period', 'notice days'],
  },
  { key: 'in_band', type: 'boolean', default: false, aliases: ['in band'] },
  { key: 'core_ok', type: 'boolean', default: false, aliases: ['core ok'] },
  {
    key: 'edu_inst',
    type: 'string',
    default: '',
    aliases: ['education', 'institute', 'university'],
  },
  { key: 'summary', type: 'string', default: '', aliases: ['bio', 'notes'] },
  {
    key: 'best_persona',
    type: 'string',
    default: '',
    aliases: ['best persona', 'persona'],
  },
  {
    key: 'best_persona_name',
    type: 'string',
    default: '',
    aliases: ['best persona name', 'persona name'],
  },
  { key: 'level', type: 'number', default: null },
  {
    key: 'is_mgr',
    type: 'boolean',
    default: false,
    aliases: ['is manager', 'manager'],
  },
  {
    key: 'sen_label',
    type: 'string',
    default: '',
    aliases: ['seniority label', 'seniority fit'],
  },
  {
    key: 'sen_dir',
    type: 'string',
    default: '',
    aliases: ['seniority direction'],
  },
  {
    key: 'n_role_skills',
    type: 'number',
    default: 0,
    aliases: ['role skills', 'n role skills'],
  },
  {
    key: 'osint_conf',
    type: 'string',
    default: '',
    aliases: ['osint confidence', 'confidence'],
  },
  { key: 'personas', type: 'json', default: {} },
]

function normHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export function buildFieldLookup(): Map<string, FieldSpec> {
  const map = new Map<string, FieldSpec>()
  for (const spec of FIELD_SPECS) {
    map.set(normHeader(spec.key), spec)
    for (const alias of spec.aliases ?? []) map.set(normHeader(alias), spec)
  }
  return map
}

function coerce(raw: unknown, spec: FieldSpec): unknown {
  const v = (raw ?? '').toString().trim()
  if (v === '') return spec.default
  if (spec.type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : spec.default
  }
  if (spec.type === 'boolean') return /^(true|yes|y|1)$/i.test(v)
  if (spec.type === 'json') {
    try {
      return JSON.parse(v)
    } catch {
      return spec.default
    }
  }
  return v
}

/** Marker interface for a merged candidate object shape — intentionally
 * loose (mirrors the JSON schema of the existing dashboards' `candidates`
 * array, which varies slightly across role templates). */
export type CandidateRecord = Record<string, unknown>

export function mapRowToCandidate(
  row: Record<string, string>,
  fieldLookup: Map<string, FieldSpec>,
  meta: { personas?: Record<string, string> } | undefined,
): CandidateRecord {
  const candidate: CandidateRecord = {}
  for (const spec of FIELD_SPECS) candidate[spec.key] = spec.default
  for (const rawHeader of Object.keys(row)) {
    const spec = fieldLookup.get(normHeader(rawHeader))
    if (!spec) continue // unrecognized column — ignored, never invented into a new field
    candidate[spec.key] = coerce(row[rawHeader], spec)
  }
  if (!candidate.loc_full && candidate.loc) candidate.loc_full = candidate.loc
  if (candidate.best_persona && !candidate.best_persona_name) {
    const name = meta?.personas?.[candidate.best_persona as string]
    if (name) candidate.best_persona_name = name
  }
  return candidate
}

export function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < len) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      pushField()
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    i++
  }
  if (field.length > 0 || row.length > 0) pushRow()
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop()
  if (!rows.length) return []
  const headers = rows[0].map((h) => h.trim())
  return rows
    .slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? r[idx] : ''
      })
      return obj
    })
}

// Scans forward from an opening `{`/`[` and returns the index of its
// matching close, respecting JSON double-quoted strings (with backslash
// escaping) so brackets inside string values are never miscounted.
export function findMatchingBracket(str: string, openIdx: number): number {
  const openCh = str[openIdx]
  const closeCh = openCh === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(
    'Reached end of file looking for a matching bracket — malformed data block?',
  )
}

interface DataBlockLocation {
  openBraceIdx: number
  closeBraceIdx: number
  arrCloseIdx: number
}

export function locateDataBlock(html: string): DataBlockLocation {
  const marker = 'window.__D'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) {
    throw new Error(
      'Could not find the candidate data block in this dashboard — this tool only supports the Talent Landscape dashboard template.',
    )
  }
  const eqIdx = html.indexOf('=', markerIdx)
  const openBraceIdx = html.indexOf('{', eqIdx)
  const closeBraceIdx = findMatchingBracket(html, openBraceIdx)
  const candidatesKeyIdx = html.indexOf('"candidates"', openBraceIdx)
  if (candidatesKeyIdx === -1 || candidatesKeyIdx > closeBraceIdx) {
    throw new Error(
      'Found the dashboard data block but it has no "candidates" array — unexpected schema.',
    )
  }
  const arrOpenIdx = html.indexOf('[', candidatesKeyIdx)
  const arrCloseIdx = findMatchingBracket(html, arrOpenIdx)
  return { openBraceIdx, closeBraceIdx, arrCloseIdx }
}

function norm(s: unknown): string {
  return (s ?? '').toString().trim().toLowerCase().replace(/\/+$/, '')
}

export interface MergeSkip {
  name?: string
  reason: string
}

export interface MergeResult {
  /** The full merged HTML, or null if there were no new unique candidates
   * to append (nothing to write). */
  mergedHtml: string | null
  existingCount: number
  appendedCount: number
  skipped: MergeSkip[]
  finalTotal: number
}

interface ParsedData {
  meta?: { personas?: Record<string, string> }
  candidates: CandidateRecord[]
  [key: string]: unknown
}

/** Appends candidates parsed from `csvText` into `html`'s embedded
 * candidate data block. Existing candidates and every other byte of the
 * file are guaranteed untouched — verified internally before returning
 * (throws instead of returning a bad result if the check fails). */
export function mergeCandidatesIntoHtml(
  html: string,
  csvText: string,
): MergeResult {
  const { openBraceIdx, closeBraceIdx, arrCloseIdx } = locateDataBlock(html)
  const jsonText = html.slice(openBraceIdx, closeBraceIdx + 1)
  const data = JSON.parse(jsonText) as ParsedData // read-only: analysis only, never re-written

  if (!Array.isArray(data.candidates)) {
    throw new Error(
      'Parsed data has no "candidates" array — unexpected schema.',
    )
  }

  // Dedup keys: LinkedIn URL is the primary key (per spec), with email and
  // candidate ID as fallbacks, and name as a last resort — matching
  // whichever identity fields this particular dashboard schema/CSV
  // actually carries.
  const existingLi = new Set(
    data.candidates.map((c) => norm(c.li_url)).filter(Boolean),
  )
  const existingEmail = new Set(
    data.candidates.map((c) => norm(c.email)).filter(Boolean),
  )
  const existingCandidateId = new Set(
    data.candidates.map((c) => norm(c.candidate_id)).filter(Boolean),
  )
  const existingNames = new Set(
    data.candidates.map((c) => norm(c.name)).filter(Boolean),
  )
  let maxRank = 0
  for (const c of data.candidates) {
    const r = Number(c.rank)
    if (Number.isFinite(r) && r > maxRank) maxRank = r
  }

  const rows = parseCsv(csvText)
  const fieldLookup = buildFieldLookup()

  const appended: CandidateRecord[] = []
  const skipped: MergeSkip[] = []
  for (const row of rows) {
    const candidate = mapRowToCandidate(row, fieldLookup, data.meta)
    const name = candidate.name as string
    if (!name) {
      skipped.push({ reason: 'missing name' })
      continue
    }
    const liKey = norm(candidate.li_url)
    const emailKey = norm(candidate.email)
    const candidateIdKey = norm(candidate.candidate_id)
    const nameKey = norm(name)
    const isDuplicate =
      (liKey && existingLi.has(liKey)) ||
      (emailKey && existingEmail.has(emailKey)) ||
      (candidateIdKey && existingCandidateId.has(candidateIdKey)) ||
      existingNames.has(nameKey)
    if (isDuplicate) {
      skipped.push({ name, reason: 'duplicate of an existing candidate' })
      continue
    }
    maxRank += 1
    candidate.rank = maxRank
    appended.push(candidate)
    if (liKey) existingLi.add(liKey)
    if (emailKey) existingEmail.add(emailKey)
    if (candidateIdKey) existingCandidateId.add(candidateIdKey)
    existingNames.add(nameKey)
  }

  const existingCount = data.candidates.length
  if (appended.length === 0) {
    return {
      mergedHtml: null,
      existingCount,
      appendedCount: 0,
      skipped,
      finalTotal: existingCount,
    }
  }

  const newJsonFragment = appended.map((c) => JSON.stringify(c)).join(',')
  const insertion = (existingCount > 0 ? ',' : '') + newJsonFragment
  const mergedHtml =
    html.slice(0, arrCloseIdx) + insertion + html.slice(arrCloseIdx)

  // Self-verify before returning: re-extract from the merged output and
  // confirm (a) it's still valid JSON, (b) the candidate count is exactly
  // right, (c) every existing candidate is byte-for-byte unchanged, and
  // (d) nothing outside the insertion point moved.
  const verify = locateDataBlock(mergedHtml)
  const mergedData = JSON.parse(
    mergedHtml.slice(verify.openBraceIdx, verify.closeBraceIdx + 1),
  ) as ParsedData
  if (mergedData.candidates.length !== existingCount + appended.length) {
    throw new Error('Self-check failed: candidate count mismatch after merge.')
  }
  for (let i = 0; i < existingCount; i++) {
    if (
      JSON.stringify(mergedData.candidates[i]) !==
      JSON.stringify(data.candidates[i])
    ) {
      throw new Error(
        `Self-check failed: existing candidate at index ${i} changed after merge.`,
      )
    }
  }
  const before = html.slice(0, arrCloseIdx)
  const after = html.slice(arrCloseIdx)
  if (
    mergedHtml.slice(0, arrCloseIdx) !== before ||
    mergedHtml.slice(arrCloseIdx + insertion.length) !== after
  ) {
    throw new Error(
      'Self-check failed: bytes outside the insertion point changed.',
    )
  }

  return {
    mergedHtml,
    existingCount,
    appendedCount: appended.length,
    skipped,
    finalTotal: mergedData.candidates.length,
  }
}
