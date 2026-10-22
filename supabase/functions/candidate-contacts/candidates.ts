// Reads the candidate list (name, LinkedIn URL, employer, title) out of a
// stored dashboard HTML file. The dashboard file itself is the source of
// truth for who is on a dashboard: a lookup is only ever made for a LinkedIn
// profile that actually appears in that dashboard, so nobody can spend
// vendor credits on arbitrary profiles by crafting a request.
//
// Two embedded-data shapes are known (see src/lib/htmlNormalization/validate.ts):
//   Adobe generator:              const PAYLOAD = {"cand":[{"name","li","emp","title",...}]}
//   Talent Intelligence (Lyca):   const DATA={...}, ROWS=[{"n","u","c","t",...}]

export interface DashboardCandidate {
  name: string
  linkedinUrl: string
  linkedinKey: string
  company: string | null
  title: string | null
}

const ARRAY_MARKERS = [/"cand"\s*:\s*\[/g, /\bROWS\s*=\s*\[/g]

/** "https://www.LinkedIn.com/in/Jane-Doe/?x=1" -> "linkedin.com/in/jane-doe" */
export function linkedinKey(url: string): string | null {
  const match = /linkedin\.com\/(in|pub)\/([^/?#\s"']+)/i.exec(url)
  if (!match) return null
  let slug = match[2]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // keep the raw slug
  }
  return `linkedin.com/${match[1].toLowerCase()}/${slug.toLowerCase()}`
}

/** The JSON array starting at `start` (a "["), honoring strings/escapes. */
function sliceJsonArray(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function extractCandidates(html: string): DashboardCandidate[] {
  const out: DashboardCandidate[] = []
  const seen = new Set<string>()
  for (const marker of ARRAY_MARKERS) {
    marker.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = marker.exec(html))) {
      const json = sliceJsonArray(html, match.index + match[0].length - 1)
      if (!json) continue
      let rows: unknown
      try {
        rows = JSON.parse(json)
      } catch {
        continue
      }
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        const name = str(r.name) ?? str(r.n)
        const url =
          str(r.li) ?? str(r.u) ?? str(r.linkedin) ?? str(r.linkedin_url)
        const key = url ? linkedinKey(url) : null
        if (!name || !url || !key || seen.has(key)) continue
        seen.add(key)
        out.push({
          name,
          linkedinUrl: url,
          linkedinKey: key,
          company: str(r.emp) ?? str(r.c) ?? str(r.company) ?? null,
          title: str(r.title) ?? str(r.t) ?? null,
        })
      }
    }
  }
  return out
}
