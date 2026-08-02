// Canonical HTML Normalization pipeline:
//
//   Input File -> extract -> sanitize -> canonicalize -> validate -> Store
//
// This is the ONE place that sequence is assembled — callers (today, just
// dashboardAdmin.service.ts's uploadDashboard) never touch extract/sanitize/
// canonicalize/validate directly, so the ordering and error handling here
// can't drift between call sites as more are added.
//
// Validation runs AFTER canonicalize, against the same (already-fixed-up)
// Document canonicalize mutated in place — a missing viewport meta or title
// is filled in before validation ever sees it, so those surface as
// warnings ("this was added") rather than errors, while a genuine problem
// (no candidate data found, broken markup) still stops the upload.

import { findExtractorFor } from './extractors'
import { sanitizeDocument } from './sanitize'
import { canonicalizeDocument } from './canonicalize'
import { validateDocument } from './validate'
import { NormalizationError, type NormalizationResult } from './types'

export async function normalizeToCanonicalHtml(
  file: File,
): Promise<NormalizationResult> {
  const extractor = findExtractorFor(file)
  if (!extractor) {
    throw new NormalizationError([
      {
        code: 'unsupported-format',
        message: `Unsupported file type: ${file.name}. Only HTML dashboards are supported right now.`,
        severity: 'error',
      },
    ])
  }

  const { document } = await extractor.extract(file)

  const { issues: sanitizeIssues } = sanitizeDocument(document)
  const { html, issues: canonicalizeIssues } = canonicalizeDocument(document)
  const { valid, issues: validationIssues } = validateDocument(document)

  const allIssues = [
    ...sanitizeIssues,
    ...canonicalizeIssues,
    ...validationIssues,
  ]

  if (!valid || !html) {
    throw new NormalizationError(allIssues)
  }

  return {
    html,
    warnings: allIssues.filter((i) => i.severity === 'warning'),
  }
}
