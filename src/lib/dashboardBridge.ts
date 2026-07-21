/**
 * Contract that any embedded HTML dashboard must follow so the host app can
 * wire up candidate status updates automatically:
 *
 *   <tr data-candidate-row
 *       data-candidate-name="Jane Doe"
 *       data-candidate-email="jane@example.com">
 *     ...
 *     <select data-longlist-status></select>
 *     <input data-longlist-remarks placeholder="Remarks" />
 *   </tr>
 *
 * The <select> may be left empty — the injected bootstrap script populates
 * it with the standard status options if it has none. The dashboard's own
 * HTML/CSS never defines status colors or labels — those come entirely from
 * this app's statusConfig.ts and are pushed down into the iframe as plain
 * data via postMessage. The uploaded HTML only ever emits a status value and
 * reflects whatever value/color it's told to.
 */
export const BRIDGE_ATTRS = {
  row: 'data-candidate-row',
  name: 'data-candidate-name',
  email: 'data-candidate-email',
  status: 'data-longlist-status',
  remarks: 'data-longlist-remarks',
} as const

/**
 * Injects a reference to the static /dashboard-bridge.js bootstrap script
 * (served from this app's own origin) plus the current dashboard's ID.
 *
 * The script is a real same-origin file, not inlined and not a blob: URL,
 * because the dashboard renders inside an iframe sandboxed without
 * allow-same-origin: its document has an opaque origin, so it can neither
 * run an inline <script> body under this app's script-src 'self' CSP nor
 * dereference a blob: URL created by the parent. A normal cross-document
 * same-origin script src is unaffected by either restriction.
 */
export function injectBridgeScript(html: string, dashboardId: string): string {
  const meta = `<meta name="longlist-dashboard-id" content="${dashboardId}">`
  const script = `<script src="${window.location.origin}/dashboard-bridge.js"></script>`

  let result = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${meta}</head>`)
    : `${meta}${html}`

  result = /<\/body>/i.test(result)
    ? result.replace(/<\/body>/i, `${script}</body>`)
    : `${result}${script}`

  return result
}
