// Strips genuinely dangerous constructs from a parsed dashboard Document,
// scoped tightly to what's actually risky rather than what's merely
// "script-shaped" — a naive sanitizer that strips all inline <script> tags
// or all onXxx="" attributes would break every real production dashboard.
// Verified against 4 live uploaded dashboards before writing this: every one
// of them uses onclick="toggleTheme()" / onclick="exportCSV()" / etc. as its
// normal, working UI wiring (dashboard-bridge.js's neutralizeInlineHandlers()
// exists specifically to pick these up at render time), and every one of
// them carries its entire rendering engine, chart library, and
// `window.__D = {...}` candidate-data payload in inline <script> tags with
// no `src`. None of that is "unsupported" — it IS the canonical format.
//
// What this removes instead is the class of thing no legitimate dashboard
// upload has ever needed and that the existing sandboxed iframe
// (sandbox="allow-scripts allow-forms allow-modals", deliberately no
// allow-same-origin — see DashboardFrame.tsx) doesn't fully neutralize on
// its own: loading a THIRD-PARTY script, framing another page inside the
// dashboard, a meta-refresh redirect, or a javascript:/data: URL.
//
// This is defense in depth, not the only line of defense — the sandbox
// remains the actual containment boundary for whatever inline JS a
// dashboard legitimately runs.

import type { ValidationIssue } from './types'

const DANGEROUS_TAGS = ['iframe', 'object', 'embed', 'base', 'link'] as const
const JS_URL_RE = /^\s*javascript:/i
const DATA_HTML_URL_RE = /^\s*data:text\/html/i
const URL_ATTRS = ['href', 'src', 'action', 'formaction'] as const

export interface SanitizeResult {
  removedCount: number
  issues: ValidationIssue[]
}

export function sanitizeDocument(document: Document): SanitizeResult {
  const issues: ValidationIssue[] = []
  let removedCount = 0

  // External scripts: every real script in a canonical dashboard is inline.
  // A remote <script src> is exactly "arbitrary code this app doesn't
  // control, loaded from wherever the uploader pointed it" — the one script
  // vector the sandbox's allow-scripts can't distinguish from the
  // dashboard's own legitimate inline code, since both just "run JS".
  document.querySelectorAll('script[src]').forEach((el) => {
    el.remove()
    removedCount++
  })
  if (removedCount > 0) {
    issues.push({
      code: 'external-script-removed',
      message: `Removed ${removedCount} external <script src> reference(s) — only inline scripts are permitted.`,
      severity: 'warning',
    })
  }

  // <iframe>/<object>/<embed>/<base>/<link rel=import>: framing, plugin
  // content, and base-URL hijacking have no place in a static candidate
  // report and aren't part of anything the 4 verified real dashboards use.
  // <link rel="stylesheet"> is legitimate (dashboards may reference their
  // own same-document-relative assets) so `link` is only stripped when it's
  // NOT a plain stylesheet/icon reference.
  let structuralRemoved = 0
  DANGEROUS_TAGS.forEach((tag) => {
    document.querySelectorAll(tag).forEach((el) => {
      if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase()
        if (rel === 'stylesheet' || rel === 'icon' || rel === 'shortcut icon')
          return
      }
      el.remove()
      structuralRemoved++
    })
  })
  if (structuralRemoved > 0) {
    issues.push({
      code: 'unsupported-element-removed',
      message: `Removed ${structuralRemoved} unsupported element(s) (iframe/object/embed/base/link-import).`,
      severity: 'warning',
    })
  }
  removedCount += structuralRemoved

  // Meta-refresh: the one purely declarative redirect/reload vector HTML has.
  let metaRefreshRemoved = 0
  document.querySelectorAll('meta[http-equiv="refresh" i]').forEach((el) => {
    el.remove()
    metaRefreshRemoved++
  })
  if (metaRefreshRemoved > 0) {
    issues.push({
      code: 'meta-refresh-removed',
      message: 'Removed a meta-refresh redirect.',
      severity: 'warning',
    })
  }
  removedCount += metaRefreshRemoved

  // javascript:/data:text/html URLs in any URL-bearing attribute. Left in
  // place structurally (removing the whole element would be more
  // destructive than necessary for what's normally just one bad attribute
  // on an otherwise-fine link/button) — the attribute itself is cleared.
  let urlsNeutralized = 0
  URL_ATTRS.forEach((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => {
      const value = el.getAttribute(attr) || ''
      if (JS_URL_RE.test(value) || DATA_HTML_URL_RE.test(value)) {
        el.removeAttribute(attr)
        urlsNeutralized++
      }
    })
  })
  if (urlsNeutralized > 0) {
    issues.push({
      code: 'unsafe-url-neutralized',
      message: `Neutralized ${urlsNeutralized} javascript:/data:text-html URL(s).`,
      severity: 'warning',
    })
  }
  removedCount += urlsNeutralized

  // Cross-origin form submissions. A relative or same-origin action is left
  // alone; an absolute action pointing elsewhere is defanged. Same-origin
  // here means "this app's own origin" — the dashboard's own opaque iframe
  // origin can never legitimately match an absolute URL anyway, so any
  // absolute http(s) action is by definition pointed somewhere else.
  let formsNeutralized = 0
  document.querySelectorAll('form[action]').forEach((el) => {
    const action = el.getAttribute('action') || ''
    if (/^https?:\/\//i.test(action)) {
      el.setAttribute('action', '#')
      formsNeutralized++
    }
  })
  if (formsNeutralized > 0) {
    issues.push({
      code: 'external-form-action-neutralized',
      message: `Neutralized ${formsNeutralized} form(s) submitting to an external URL.`,
      severity: 'warning',
    })
  }
  removedCount += formsNeutralized

  return { removedCount, issues }
}
