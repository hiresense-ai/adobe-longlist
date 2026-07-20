import { CANDIDATE_STATUS_OPTIONS } from '@/constants'

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
 * it with the standard status options if it has none.
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
 * status dropdowns to postMessage the host app, and listens for
 * acknowledgements / initial values coming back down.
 */
export function buildBridgeScript(dashboardId: string): string {
  const statusOptionsJson = JSON.stringify(CANDIDATE_STATUS_OPTIONS)
  const attrs = BRIDGE_ATTRS

  return `
(function () {
  var DASHBOARD_ID = ${JSON.stringify(dashboardId)};
  var STATUS_OPTIONS = ${statusOptionsJson};
  var ATTR_ROW = ${JSON.stringify(attrs.row)};
  var ATTR_NAME = ${JSON.stringify(attrs.name)};
  var ATTR_EMAIL = ${JSON.stringify(attrs.email)};
  var ATTR_STATUS = ${JSON.stringify(attrs.status)};
  var ATTR_REMARKS = ${JSON.stringify(attrs.remarks)};

  function getRow(select) {
    return select.closest('[' + ATTR_ROW + ']') || select;
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

  function showFeedback(select, ok, message) {
    var badge = select.parentElement && select.parentElement.querySelector('[data-longlist-feedback]');
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute('data-longlist-feedback', '');
      badge.style.marginLeft = '8px';
      badge.style.fontFamily = 'system-ui, sans-serif';
      badge.style.fontSize = '12px';
      badge.style.borderRadius = '9999px';
      badge.style.padding = '2px 8px';
      select.insertAdjacentElement('afterend', badge);
    }
    badge.textContent = ok ? 'Saved' : (message || 'Error');
    badge.style.background = ok ? '#dcfce7' : '#fee2e2';
    badge.style.color = ok ? '#15803d' : '#b91c1c';
    window.clearTimeout(badge._hideTimer);
    badge._hideTimer = window.setTimeout(function () {
      badge.remove();
    }, 2500);
  }

  function handleChange(event) {
    var select = event.target;
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
    var selects = document.querySelectorAll('[' + ATTR_STATUS + ']');
    selects.forEach(function (select) {
      populateOptions(select);
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

/** Injects the bootstrap bridge script into raw dashboard HTML before </body>. */
export function injectBridgeScript(html: string, dashboardId: string): string {
  const script = `<script>${buildBridgeScript(dashboardId)}</script>`

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`)
  }

  return `${html}${script}`
}
