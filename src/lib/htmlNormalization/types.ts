// Canonical HTML Normalization — shared types.
//
// The pipeline is: extract -> sanitize -> canonicalize -> validate. Every
// stage after `extract` operates on a plain DOM Document, never on a raw
// string, so sanitization/canonicalization can't be defeated by a payload
// crafted to survive a regex but not a real parse (the classic HTML-sanitizer
// bypass class of bug). Only the final canonicalize step re-serializes back
// to a string, once, right before it's written to Storage.

/** Where the uploaded content originally came from. Every extractor tags its
 * output with this so downstream stages (and audit logging, if this is ever
 * wired up) can tell what was actually uploaded, not just that HTML resulted. */
export type SourceFormat =
  'html' | 'markdown' | 'docx' | 'pdf' | 'ai-generated' | 'other'

/**
 * What every InputExtractor produces, regardless of source format. For an
 * HTML source, `document` is the parsed upload itself — presentation and
 * business data are the same artifact for this format (see the module
 * comment in extractors/htmlExtractor.ts), so there is nothing further to
 * "extract" out of it. A future extractor for a genuinely structured source
 * (Markdown table, DOCX table, a PDF's parsed text) would instead populate
 * `records` with real structured rows and build `document` from the
 * canonical template — see canonicalize.ts's TEMPLATE_RENDERING_NOTE.
 */
export interface ExtractedContent {
  sourceFormat: SourceFormat
  document: Document
  /** Structured rows pulled from the source, when the source format has them
   * separable from presentation (a future Markdown/DOCX/CSV-like path).
   * Undefined for HTML input, where there is nothing to separate. */
  records?: Record<string, unknown>[]
}

/** One thing the pipeline found wrong or fixed. `severity: 'error'` stops
 * the upload; `'warning'` is informational only (canonicalize.ts already
 * applied a safe fallback, e.g. inserting a missing viewport meta tag). */
export interface ValidationIssue {
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

export interface NormalizationResult {
  html: string
  warnings: ValidationIssue[]
}

/** Thrown by the pipeline when validation fails. Carries the full issue list
 * (not just the first one) so a caller — today, the upload dialog's error
 * toast — can show the admin everything wrong at once instead of a
 * fix-one-resubmit-find-the-next loop. */
export class NormalizationError extends Error {
  issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super(
      issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join(' '),
    )
    this.name = 'NormalizationError'
    this.issues = issues
  }
}

/**
 * Pluggable input handler — the extension point new source formats attach
 * to. Implement `canHandle` + `extract` for a new format (Markdown, DOCX,
 * PDF, ...) and register it in extractors/index.ts; nothing in sanitize.ts,
 * canonicalize.ts, validate.ts, pipeline.ts, or the frontend needs to change.
 *
 * Only htmlExtractor.ts exists today. The others are intentionally not
 * built in this pass — see the module comment on canonicalize.ts for why
 * "convert a DOCX to this exact canonical format" is a materially different,
 * larger piece of work than "parse the DOCX's text."
 */
export interface InputExtractor {
  sourceFormat: SourceFormat
  canHandle(file: File): boolean
  extract(file: File): Promise<ExtractedContent>
}
