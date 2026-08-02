// HTML input extractor — the only InputExtractor implemented today, since
// HTML upload is the only input format this app currently accepts.
//
// Unlike a hypothetical Markdown/DOCX/CSV extractor, this one does not pull
// structured `records` out: real uploaded dashboards (the "Talent Landscape"
// generator family — see src/lib/dashboardCandidateMerge.ts's module
// comment) embed their candidate data as one JSON blob assigned to
// `window.__D` inside a <script> tag, which every other script on the page
// (render(), apply(), the charts, CSV export, ...) reads from live at
// runtime. There is no way to separate "the data" from "the presentation"
// for this format without actually executing that JavaScript — which this
// pipeline deliberately never does against untrusted uploaded content, at
// upload time or otherwise. So for HTML input, extraction is "parse it into
// a real Document," and normalization for the rest of the pipeline means
// sanitizing and validating that whole document, not regenerating it from
// separated parts.

import type { ExtractedContent, InputExtractor } from '../types'

export const htmlExtractor: InputExtractor = {
  sourceFormat: 'html',

  canHandle(file) {
    return (
      file.name.toLowerCase().endsWith('.html') ||
      file.type === 'text/html' ||
      file.type === 'application/xhtml+xml'
    )
  },

  async extract(file) {
    const text = await file.text()
    // DOMParser never throws on malformed markup — it returns a document
    // containing a <parsererror> element instead. That's checked in
    // validate.ts (a structural concern), not here: this stage's only job
    // is producing a Document, however well-formed the input turned out to
    // be, since sanitize.ts needs a real DOM to operate on regardless.
    const document = new DOMParser().parseFromString(text, 'text/html')
    return { sourceFormat: 'html', document } satisfies ExtractedContent
  },
}
