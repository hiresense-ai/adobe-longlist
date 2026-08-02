// Canonicalize: fills in baseline document scaffolding that a well-formed
// but incomplete upload might be missing, then serializes the final DOM back
// to an HTML string exactly once, right before it's written to Storage.
//
// TEMPLATE_RENDERING_NOTE — what this deliberately does NOT do: regenerate
// the Talent Landscape generator's actual layout (the charts, the filter
// rail, the persona grid, `<table class="cand">` and its JS-driven rows)
// from scratch. That format is the output of a specific, sophisticated
// report-generation tool — a real 350-480KB document with an inlined Chart.js
// bundle, verified against 4 live production dashboards while building this
// pipeline — not something this pass hand-authors a byte-for-byte
// regenerator for. For HTML input (the only format this app accepts today),
// "canonicalize" means "make sure the baseline document shell is present and
// correct"; the generator's own output, once sanitized, already IS the
// canonical body.
//
// A future extractor for a genuinely structured source (e.g. a Markdown
// table with name/status/notes columns) would populate ExtractedContent
// .records and need a DIFFERENT function here — a real template renderer
// that builds a fresh document embedding those records as a window.__D
// block (see validate.ts's CANDIDATE_DATA_MARKER) inside the same canonical
// shell this function already produces. That renderer doesn't exist yet;
// building it is a distinct, larger effort from parsing the source file,
// and out of scope for this pass — see the top-level summary.

import type { ValidationIssue } from './types'

export interface CanonicalizeResult {
  html: string
  issues: ValidationIssue[]
}

export function canonicalizeDocument(document: Document): CanonicalizeResult {
  const issues: ValidationIssue[] = []

  if (!document.documentElement) {
    // validate.ts already treats this as a hard error; nothing safe to
    // fabricate here (an <html> root isn't optional content the way a
    // <title> or a meta tag is).
    return { html: '', issues }
  }

  if (!document.documentElement.hasAttribute('lang')) {
    document.documentElement.setAttribute('lang', 'en')
  }

  let head = document.head
  if (!head) {
    head = document.createElement('head')
    document.documentElement.insertBefore(head, document.body ?? null)
    issues.push({
      code: 'head-inserted',
      message: 'Added a missing <head> element.',
      severity: 'warning',
    })
  }

  if (!head.querySelector('meta[charset]')) {
    const meta = document.createElement('meta')
    meta.setAttribute('charset', 'UTF-8')
    head.insertBefore(meta, head.firstChild)
  }

  if (!head.querySelector('meta[name="viewport" i]')) {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'viewport')
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0')
    head.appendChild(meta)
  }

  const titleEl = head.querySelector('title')
  if (!titleEl || !titleEl.textContent?.trim()) {
    const title = titleEl ?? document.createElement('title')
    title.textContent = 'Talent Intelligence Dashboard'
    if (!titleEl) head.appendChild(title)
  }

  // documentElement.outerHTML never includes the doctype — DOMParser
  // discards it from its own `document.doctype` representation on
  // serialization the same way. Always prepended explicitly instead of
  // conditionally, since "prepend the standard HTML5 doctype" is correct
  // whether or not the upload had one (and idempotent if it already
  // matched).
  const html = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`

  return { html, issues }
}
