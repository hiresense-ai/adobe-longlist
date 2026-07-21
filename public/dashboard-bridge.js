// Adobe Longlist — dashboard bootstrap bridge.
//
// This file is static and identical for every uploaded dashboard: it never
// contains a status list, colors, or a dashboard ID. All of that comes down
// from the host app via postMessage (longlist:init-config / init-statuses /
// theme-change) after this script announces longlist:ready. That's what
// keeps uploaded HTML dashboards generic — no business logic or color
// mappings ever live here or in the uploaded file itself.
//
// Served from this app's own origin (referenced via <script src>, not
// inlined) because the dashboard iframe is sandboxed without
// allow-same-origin, so its document has an opaque origin: an inline
// <script> body would be blocked by this app's script-src 'self' CSP, and a
// blob: URL created in the parent can't be dereferenced by an opaque-origin
// document either. A same-origin script src is unaffected by both.
;(function () {
  var ATTR_ROW = 'data-candidate-row'
  var ATTR_NAME = 'data-candidate-name'
  var ATTR_EMAIL = 'data-candidate-email'
  var ATTR_STATUS = 'data-longlist-status'
  var ATTR_REMARKS = 'data-longlist-remarks'

  var meta = document.querySelector('meta[name="longlist-dashboard-id"]')
  var DASHBOARD_ID = meta ? meta.getAttribute('content') : null

  var STATUS_OPTIONS = []
  var STATUS_STYLES = {}
  var currentTheme = 'light'
  var selects = []
  var wired = false

  function getRow(select) {
    return select.closest('[' + ATTR_ROW + ']') || select
  }

  function injectBaseStyles() {
    var style = document.createElement('style')
    style.textContent =
      '[' +
      ATTR_STATUS +
      '] { transition: background-color 220ms ease, border-color 220ms ease, color 220ms ease; }' +
      '[' +
      ATTR_STATUS +
      ']:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: 2px; }'
    document.head.appendChild(style)
  }

  function populateOptions(select) {
    if (select.options.length > 0) return
    STATUS_OPTIONS.forEach(function (value) {
      var option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.appendChild(option)
    })
  }

  // Colors, radius, padding, and typography are all set inline (rather than
  // via a stylesheet) so they take effect regardless of whatever CSS the
  // uploaded dashboard itself ships with.
  function applyStatusStyle(select) {
    var styles = STATUS_STYLES[select.value]
    if (!styles) return
    var palette = styles[currentTheme] || styles.light
    select.style.backgroundColor = palette.background
    select.style.color = palette.text
    select.style.borderColor = palette.border
    select.style.borderWidth = '1px'
    select.style.borderStyle = 'solid'
    select.style.borderRadius = '9999px'
    select.style.padding = '4px 10px'
    select.style.fontWeight = '500'
    select.style.fontSize = '13px'
    select.style.fontFamily = 'inherit'
    select.style.cursor = 'pointer'
    select.style.outlineColor = palette.text
  }

  function applyStylesToAll() {
    selects.forEach(applyStatusStyle)
  }

  function showFeedback(select, ok, message) {
    var badge =
      select.parentElement &&
      select.parentElement.querySelector('[data-longlist-feedback]')
    if (!badge) {
      badge = document.createElement('span')
      badge.setAttribute('data-longlist-feedback', '')
      badge.style.marginLeft = '8px'
      badge.style.fontFamily = 'inherit'
      badge.style.fontSize = '12px'
      badge.style.borderRadius = '9999px'
      badge.style.padding = '2px 8px'
      badge.style.transition = 'background-color 220ms ease, color 220ms ease'
      select.insertAdjacentElement('afterend', badge)
    }
    // Reuse the master status palette rather than inventing new colors:
    // "Selected" for success, "Rejected" for error.
    var paletteSet = STATUS_STYLES[ok ? 'Selected' : 'Rejected']
    var palette =
      (paletteSet && (paletteSet[currentTheme] || paletteSet.light)) || {}
    badge.textContent = ok ? 'Saved' : message || 'Error'
    badge.style.background = palette.background || ''
    badge.style.color = palette.text || ''
    window.clearTimeout(badge._hideTimer)
    badge._hideTimer = window.setTimeout(function () {
      badge.remove()
    }, 2500)
  }

  function handleChange(event) {
    var select = event.target
    // Recolor immediately on the user's own change, without waiting for the
    // save round-trip to Supabase to complete.
    applyStatusStyle(select)

    var row = getRow(select)
    var candidateName =
      row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME)
    if (!candidateName) return

    var candidateEmail = row.getAttribute(ATTR_EMAIL) || undefined
    var remarksEl = row.querySelector('[' + ATTR_REMARKS + ']')
    var remarks = remarksEl ? remarksEl.value : undefined

    window.parent.postMessage(
      {
        type: 'longlist:status-update',
        payload: {
          dashboardId: DASHBOARD_ID,
          candidateName: candidateName,
          candidateEmail: candidateEmail,
          status: select.value,
          remarks: remarks,
        },
      },
      '*',
    )
  }

  function wireSelects() {
    if (wired) return
    wired = true
    selects = Array.prototype.slice.call(
      document.querySelectorAll('[' + ATTR_STATUS + ']'),
    )
    selects.forEach(function (select) {
      populateOptions(select)
      applyStatusStyle(select)
      select.addEventListener('change', handleChange)
    })
  }

  function init() {
    injectBaseStyles()

    window.addEventListener('message', function (event) {
      var data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'longlist:init-config') {
        STATUS_OPTIONS = Array.isArray(data.statusOrder) ? data.statusOrder : []
        STATUS_STYLES = data.statusStyles || {}
        wireSelects()
        return
      }

      if (
        data.type === 'longlist:init-statuses' &&
        Array.isArray(data.statuses)
      ) {
        data.statuses.forEach(function (entry) {
          selects.forEach(function (select) {
            var row = getRow(select)
            var name =
              row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME)
            if (name === entry.candidateName) {
              select.value = entry.status
              applyStatusStyle(select)
            }
          })
        })
      }

      if (data.type === 'longlist:status-ack') {
        selects.forEach(function (select) {
          var row = getRow(select)
          var name =
            row.getAttribute(ATTR_NAME) || select.getAttribute(ATTR_NAME)
          if (name === data.candidateName) {
            showFeedback(select, data.success, data.error)
          }
        })
      }

      if (
        data.type === 'longlist:theme-change' &&
        (data.theme === 'light' || data.theme === 'dark')
      ) {
        currentTheme = data.theme
        applyStylesToAll()
      }
    })

    window.parent.postMessage(
      { type: 'longlist:ready', dashboardId: DASHBOARD_ID },
      '*',
    )
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
