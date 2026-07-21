import { STATUS_LIST, serializeStatusStyles } from '@/config/statusConfig'

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
 * data. The uploaded HTML only ever emits a status value and reflects
 * whatever value/color it's told to.
 */
export const BRIDGE_ATTRS = {
  row: 'data-candidate-row',
  name: 'data-candidate-name',
  email: 'data-candidate-email',
  status: 'data-longlist-status',
  remarks: 'data-longlist-remarks',
} as const

/**
 * Builds a self-contained bootstrap script (no external deps) that gets
 * injected into every dashboard HTML file before rendering. It wires up
 * status dropdowns to postMessage the host app, listens for
 * acknowledgements / initial values / theme coming back down, and colors
 * each status select purely from data supplied by the host — never from
 * logic of its own.
 */
export function buildBridgeScript(dashboardId: string): string {
  const statusOrderJson = JSON.stringify(STATUS_LIST.map((s) => s.value))
  const statusStylesJson = JSON.stringify(serializeStatusStyles())
  const attrs = BRIDGE_ATTRS

  return `
(function () {
  var DASHBOARD_ID = ${JSON.stringify(dashboardId)};
  var STATUS_OPTIONS = ${statusOrderJson};
  var STATUS_STYLES = ${statusStylesJson};
  var ATTR_ROW = ${JSON.stringify(attrs.row)};
  var ATTR_NAME = ${JSON.stringify(attrs.name)};
  var ATTR_EMAIL = ${JSON.stringify(attrs.email)};
  var ATTR_STATUS = ${JSON.stringify(attrs.status)};
  var ATTR_REMARKS = ${JSON.stringify(attrs.remarks)};
  var currentTheme = 'light';

  function getRow(select) {
    return select.closest('[' + ATTR_ROW + ']') || select;
  }

  function injectBaseStyles() {
    var style = document.createElement('style');
    style.textContent =
      '[' + ATTR_STATUS + '] { transition: background-color 220ms ease, border-color 220ms ease, color 220ms ease; }' +
      '[' + ATTR_STATUS + ']:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: 2px; }';
    document.head.appendChild(style);
  }

  function populateOptions(select) {
    if (select.options.length > 0) return;
    STATUS_OPTIONS.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }

  // Colors, radius, padding, and typography are all set inline (rather than
  // via a stylesheet) so they take effect regardless of whatever CSS the
  // uploaded dashboard itself ships with.
  function applyStatusStyle(select) {
    var styles = STATUS_STYLES[select.value];
    if (!styles) return;
    var palette = styles[currentTheme] || styles.light;
    select.style.backgroundColor = palette.background;
    select.style.color = palette.text;
    select.style.borderColor = palette.border;
    select.style.borderWidth = '1px';
    select.style.borderStyle = 'solid';
    select.style.borderRadius = '9999px';
    select.style.padding = '4px 10px';
    select.style.fontWeight = '500';
    select.style.fontSize = '13px';
    select.style.fontFamily = 'inherit';
    select.style.cursor = 'pointer';
    select.style.outlineColor = palette.text;
  }

  function applyStylesToAll() {
    document.querySelectorAll('[' + ATTR_STATUS + ']').forEach(applyStatusStyle);
  }

  function showFeedback(select, ok, message) {
    var badge = select.parentElement && select.parentElement.querySelector('[data-longlist-feedback]');
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute('data-longlist-feedback', '');
      badge.style.marginLeft = '8px';
      badge.style.fontFamily = 'inherit';
      badge.style.fontSize = '12px';
      badge.style.borderRadius = '9999px';
      badge.style.padding = '2px 8px';
      badge.style.transition = 'background-color 220ms ease, color 220ms ease';
      select.insertAdjacentElement('afterend', badge);
    }
    // Reuse the master status palette rather than inventing new colors:
    // "Selected" for success, "Rejected" for error.
    var paletteSet = STATUS_STYLES[ok ? 'Selected' : 'Rejected'];
    var palette = (paletteSet && (paletteSet[currentTheme] || paletteSet.light)) || {};
    badge.textContent = ok ? 'Saved' : (message || 'Error');
    badge.style.background = palette.background || '';
    badge.style.color = palette.text || '';
    window.clearTimeout(badge._hideTimer);
    badge._hideTimer = window.setTimeout(function () {
      badge.remove();
    }, 2500);
  }

  function handleChange(event) {
    var select = event.target;
    // Recolor immediately on the user's own change, without waiting for the
    // save round-trip to Supabase to complete.
    applyStatusStyle(select);

    var row = getRow(select);
    var candidateName = row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME);
    if (!candidateName) return;

    var candidateEmail = row.getAttribute(ATTR_EMAIL) || undefined;
    var remarksEl = row.querySelector('[' + ATTR_REMARKS + ']');
    var remarks = remarksEl ? remarksEl.value : undefined;

    window.parent.postMessage({
      type: 'longlist:status-update',
      payload: {
        dashboardId: DASHBOARD_ID,
        candidateName: candidateName,
        candidateEmail: candidateEmail,
        status: select.value,
        remarks: remarks,
      },
    }, '*');
  }

  function init() {
    injectBaseStyles();

    var selects = document.querySelectorAll('[' + ATTR_STATUS + ']');
    selects.forEach(function (select) {
      populateOptions(select);
      applyStatusStyle(select);
      select.addEventListener('change', handleChange);
    });

    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'longlist:init-statuses' && Array.isArray(data.statuses)) {
        data.statuses.forEach(function (entry) {
          selects.forEach(function (select) {
            var row = getRow(select);
            var name = row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME);
            if (name === entry.candidateName) {
              select.value = entry.status;
              applyStatusStyle(select);
            }
          });
        });
      }

      if (data.type === 'longlist:status-ack') {
        selects.forEach(function (select) {
          var row = getRow(select);
          var name = row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME);
          if (name === data.candidateName) {
            showFeedback(select, data.success, data.error);
          }
        });
      }

      if (data.type === 'longlist:theme-change' && (data.theme === 'light' || data.theme === 'dark')) {
        currentTheme = data.theme;
        applyStylesToAll();
      }
    });

    window.parent.postMessage({ type: 'longlist:ready', dashboardId: DASHBOARD_ID }, '*');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`
}

export interface InjectedDashboardHtml {
  html: string
  /** The bootstrap script's own blob: URL — caller must revoke it alongside the HTML's blob URL. */
  scriptUrl: string
}

/**
 * Injects the bootstrap bridge script into raw dashboard HTML before
 * </body>, referenced via an external blob: <script src>, not inline.
 *
 * This matters because the HTML gets rendered from its own blob: URL, and
 * blob: documents inherit the CSP of whichever context created them — i.e.
 * this app's own CSP (script-src 'self' blob:). An inline <script> body
 * would be silently blocked by that policy; a same-blob-scheme src is not.
 */
export function injectBridgeScript(
  html: string,
  dashboardId: string,
): InjectedDashboardHtml {
  const scriptBlob = new Blob([buildBridgeScript(dashboardId)], {
    type: 'text/javascript',
  })
  const scriptUrl = URL.createObjectURL(scriptBlob)
  const scriptTag = `<script src="${scriptUrl}"></script>`

  const html_ = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${scriptTag}</body>`)
    : `${html}${scriptTag}`

  return { html: html_, scriptUrl }
}
