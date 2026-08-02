// Structural validation against the REAL canonical contract — every check
// here is grounded in either dashboard-bridge.js's own detection logic (the
// thing that actually has to work at render time) or the embedded-data
// shapes actually found in production dashboard files (verified by
// downloading and inspecting real uploaded HTML from Storage — see below),
// not an invented spec. See the module comment on canonicalize.ts for why
// this stops at "does this look like a working canonical dashboard" rather
// than fully re-deriving what dashboard-bridge.js will find at runtime: the
// real candidate table for this format doesn't exist as static markup at
// all — dashboard-bridge.js's own looksLikeGenericCandidateTable() requires
// window.__ROWS to already be populated by the dashboard's OWN script
// having executed, which is a runtime property this pipeline can't (and
// shouldn't, for untrusted uploaded content) evaluate by running arbitrary
// uploaded JavaScript at upload time.

import { BRIDGE_ATTRS } from '@/lib/dashboardBridge'
import type { ValidationIssue, ValidationResult } from './types'

// dashboardCandidateMerge.ts's module comment claims the embedded data
// block is `window.__D = {..., candidates: [...]}`, but every real
// production dashboard sampled from Storage instead embeds
// `const PAYLOAD = {"cand": [...], "defaults":..., "facets":...,
// "personas":...}` — no `window.__D` and no `candidates` key anywhere.
// (That mismatch means dashboardCandidateMerge.ts's "Update Candidates"
// CSV-merge feature is itself currently broken against real dashboards —
// a separate, pre-existing bug outside this pipeline's scope; flagged to
// the admin/dev team separately, not silently fixed here.)
//
// Rather than hard-code one generator's variable name (which a future
// generator version or minifier pass could rename again), this checks for
// the actual JSON *key shapes* known to appear in real dashboards, plus the
// originally-documented window.__D/"candidates" shape as a fallback in case
// some other dashboard family in the wild still uses it.
const CANDIDATE_DATA_MARKERS = [
  /window\.__D\b/,
  /"candidates"\s*:\s*\[/,
  /"cand"\s*:\s*\[/,
]

const MIN_DOCUMENT_LENGTH = 200

export function validateDocument(document: Document): ValidationResult {
  const issues: ValidationIssue[] = []

  // DOMParser never throws; a genuinely broken parse surfaces as a
  // <parsererror> element instead. This is the one hard "not HTML at all"
  // failure — everything else below is either auto-fixed by
  // canonicalize.ts or a soft warning.
  if (document.querySelector('parsererror')) {
    issues.push({
      code: 'broken-markup',
      message:
        "This file isn't valid HTML — it couldn't be parsed as a document.",
      severity: 'error',
    })
    // Nothing past this point can be checked meaningfully.
    return { valid: false, issues }
  }

  if (!document.documentElement) {
    issues.push({
      code: 'no-root-element',
      message: 'The document has no root <html> element.',
      severity: 'error',
    })
    return { valid: false, issues }
  }

  if (!document.head) {
    issues.push({
      code: 'missing-head',
      message: 'The document has no <head>.',
      severity: 'error',
    })
  }

  if (!document.body || document.body.children.length === 0) {
    issues.push({
      code: 'empty-body',
      message: 'The document has no body content.',
      severity: 'error',
    })
  }

  const serializedLength = document.documentElement.outerHTML.length
  if (serializedLength < MIN_DOCUMENT_LENGTH) {
    issues.push({
      code: 'suspiciously-small',
      message:
        'This document is too small to be a real dashboard — check the right file was selected.',
      severity: 'error',
    })
  }

  // Presence checks that canonicalize.ts will already have fixed by the
  // time this runs (see pipeline.ts's ordering) — recorded here as
  // warnings so the admin knows what was auto-filled, never as failures.
  if (!document.querySelector('meta[name="viewport" i]')) {
    issues.push({
      code: 'viewport-meta-missing',
      message: 'No responsive viewport meta tag was present — one was added.',
      severity: 'warning',
    })
  }
  if (!document.querySelector('title')?.textContent?.trim()) {
    issues.push({
      code: 'title-missing',
      message: 'No <title> was present — one was added.',
      severity: 'warning',
    })
  }

  // Business-data presence — the actual "contains all required sections"
  // check. Any ONE of these three signals is sufficient; they correspond to
  // the three shapes this app already knows how to render:
  //   1. An embedded candidate-data script block (see CANDIDATE_DATA_MARKERS
  //      above) — the Talent Landscape generator family.
  //   2. Explicit data-candidate-row markup — the documented BRIDGE_ATTRS
  //      contract (dashboardBridge.ts) for a hand-built or template-driven
  //      dashboard that doesn't use the generator's JS-rendered approach.
  //   3. A <table> whose header row has a name/candidate-like column —
  //      dashboard-bridge.js's own generic-table fallback signal
  //      (isNameHeader), checked here on whatever static header markup
  //      exists (the runtime-populated body itself can't be verified
  //      statically — see the module comment above).
  const hasGeneratorData = Array.from(document.querySelectorAll('script'))
    .filter((s) => !s.src)
    .some((s) =>
      CANDIDATE_DATA_MARKERS.some((marker) => marker.test(s.textContent ?? '')),
    )
  const hasExplicitMarkup = document.querySelector(`[${BRIDGE_ATTRS.row}]`)
  const hasNameLikeTableHeader = Array.from(
    document.querySelectorAll('table'),
  ).some((table) => tableHasNameHeader(table))

  if (!hasGeneratorData && !hasExplicitMarkup && !hasNameLikeTableHeader) {
    issues.push({
      code: 'no-candidate-data-found',
      message:
        "Couldn't find any candidate data in this file (no embedded candidate-data script, no data-candidate-row markup, and no table with a Name/Candidate column) — this doesn't look like a candidate dashboard.",
      severity: 'error',
    })
  }

  const hasErrors = issues.some((i) => i.severity === 'error')
  return { valid: !hasErrors, issues }
}

function tableHasNameHeader(table: Element): boolean {
  const headRow = table.querySelector('thead tr') ?? table.querySelector('tr')
  if (!headRow) return false
  const cells = Array.from(headRow.querySelectorAll('th, td'))
  return cells.some((cell) => {
    const text = (cell.textContent || '').trim().toLowerCase()
    return text === 'candidate' || text === 'name' || text.includes('candidate')
  })
}
