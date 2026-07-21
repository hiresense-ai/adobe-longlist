// Adobe Longlist — dashboard bootstrap bridge.
//
// This file is static and identical for every uploaded dashboard: it never
// contains a status list, an action list, colors, or a dashboard ID. All of
// that comes down from the host app via postMessage (longlist:init-config /
// init-statuses / theme-change) after this script announces longlist:ready.
// That's what keeps uploaded HTML dashboards generic — no business logic or
// color mappings ever live here or in the uploaded file itself.
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
  var ACTION_ATTR = 'data-longlist-action'
  var ACTION_HEADER_ATTR = 'data-longlist-action-header'
  var ACTION_NAME_ATTR = 'data-longlist-action-name'

  var meta = document.querySelector('meta[name="longlist-dashboard-id"]')
  var DASHBOARD_ID = meta ? meta.getAttribute('content') : null

  var STATUS_OPTIONS = []
  var STATUS_STYLES = {}
  var ACTION_OPTIONS = []
  var ACTION_STYLES = {}
  var currentTheme = 'light'
  var selects = []
  var wired = false
  // candidate name (lowercased) -> current action value ('' / null = unset)
  var actionValuesByName = {}

  function getRow(select) {
    return select.closest('[' + ATTR_ROW + ']') || select
  }

  // A plain data-URI chevron (neutral gray, theme-agnostic) — the closed
  // native <select> arrow looks cheap for a "clickable action button" feel,
  // so appearance is reset and this stands in for it.
  var CHEVRON_SVG =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="%236B7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"%3E%3Cpolyline points="6 9 12 15 18 9"/%3E%3C/svg%3E'

  function injectBaseStyles() {
    var style = document.createElement('style')
    style.textContent =
      '[' +
      ATTR_STATUS +
      '] { transition: background-color 220ms ease, border-color 220ms ease, color 220ms ease; }' +
      '[' +
      ATTR_STATUS +
      ']:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: 2px; }' +
      // Action dropdown: styled like a modern SaaS action button (GitHub /
      // Linear / Atlassian style) rather than a default browser select.
      // Only the box-model/typography/chrome live here — background/text/
      // border colors are always set per-selected-value via inline style in
      // applyActionStyle(), never here.
      '[' +
      ACTION_ATTR +
      '] {' +
      'appearance: none; -webkit-appearance: none; -moz-appearance: none;' +
      'height: 42px; min-width: 260px;' +
      'padding: 0 40px 0 18px;' +
      'border-radius: 9999px; border: 1px solid transparent;' +
      'font-weight: 600; font-size: 14px; font-family: inherit; line-height: 1;' +
      'cursor: pointer;' +
      'background-repeat: no-repeat; background-position: right 16px center; background-size: 12px 12px;' +
      "background-image: url('" +
      CHEVRON_SVG +
      "');" +
      'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05), 0 1px 2px -1px rgba(0,0,0,0.04);' +
      'transition: background-color 200ms ease, border-color 200ms ease, color 200ms ease, box-shadow 200ms ease;' +
      '}' +
      '[' +
      ACTION_ATTR +
      ']:hover { box-shadow: 0 4px 6px -2px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.06); }' +
      '[' +
      ACTION_ATTR +
      ']:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--action-ring-color, rgba(0,0,0,0.18)), 0 1px 2px 0 rgba(0,0,0,0.05); }'
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
    document.querySelectorAll('[' + ACTION_ATTR + ']').forEach(applyActionStyle)
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

  // ---------------------------------------------------------------------
  // Action column — injected at runtime next to whatever "Status" column
  // an uploaded dashboard's own table already displays (e.g. an
  // Active/Passive availability tag). That existing column is never
  // touched: we only ever read its header text to find where to insert a
  // new one, and never modify its cells.
  // ---------------------------------------------------------------------

  function getHeaderCells(table) {
    var head = table.querySelector('thead')
    if (head) {
      var cells = head.querySelectorAll('th,td')
      if (cells.length) return Array.prototype.slice.call(cells)
    }
    var firstRow = table.querySelector('tr')
    return firstRow ? Array.prototype.slice.call(firstRow.children) : []
  }

  function findColumnIndex(headerCells, matches) {
    for (var i = 0; i < headerCells.length; i++) {
      var text = (headerCells[i].textContent || '').trim().toLowerCase()
      if (matches(text)) return i
    }
    return -1
  }

  function isStatusHeader(text) {
    return text === 'status'
  }

  function isNameHeader(text) {
    return (
      text === 'candidate' ||
      text === 'name' ||
      text.indexOf('candidate') !== -1
    )
  }

  function ensureActionHeader(table, statusIdx) {
    var headRow = (table.querySelector('thead') || table).querySelector('tr')
    if (!headRow) return
    if (headRow.querySelector('[' + ACTION_HEADER_ATTR + ']')) return
    var th = document.createElement('th')
    th.setAttribute(ACTION_HEADER_ATTR, '')
    th.textContent = 'Action'
    var refNode = headRow.children[statusIdx + 1] || null
    if (refNode) headRow.insertBefore(th, refNode)
    else headRow.appendChild(th)
  }

  function populateActionOptions(select) {
    if (select.options.length > 0) return
    var blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '— Select action —'
    select.appendChild(blank)
    ACTION_OPTIONS.forEach(function (value) {
      var option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.appendChild(option)
    })
  }

  // Neutral "no action chosen yet" look — still a fully-styled button (not a
  // blank/native control), just visually quiet until a real value is picked.
  var UNSET_ACTION_PALETTE = {
    light: { background: '#F9FAFB', text: '#6B7280', border: '#E5E7EB' },
    dark: { background: '#1F2937', text: '#9CA3AF', border: '#374151' },
  }

  // Box shape/shadow/typography live entirely in the injected stylesheet
  // (shared by every action select, in every theme); this only ever sets
  // the three colors that actually vary — background, text, and border —
  // plus a CSS custom property so the :focus-visible ring in that same
  // stylesheet can pick up the current color without duplicating logic.
  function applyActionStyle(select) {
    var styles = select.value ? ACTION_STYLES[select.value] : null
    var palette =
      (styles && (styles[currentTheme] || styles.light)) ||
      UNSET_ACTION_PALETTE[currentTheme] ||
      UNSET_ACTION_PALETTE.light
    select.style.backgroundColor = palette.background
    select.style.color = palette.text
    select.style.borderColor = palette.border
    select.style.setProperty('--action-ring-color', palette.border)
  }

  function extractRowIdentity(tr, nameIdx) {
    var explicit = tr.getAttribute(ATTR_NAME)
    if (explicit) return explicit.trim()
    if (nameIdx === -1) return null
    var cell = tr.children[nameIdx]
    if (!cell) return null
    return (cell.textContent || '').trim()
  }

  function handleActionChange(event) {
    var select = event.target
    applyActionStyle(select)
    var name = select.getAttribute(ACTION_NAME_ATTR)
    if (!name) return
    var value = select.value || null
    actionValuesByName[name.toLowerCase()] = value
    window.parent.postMessage(
      {
        type: 'longlist:action-update',
        payload: {
          dashboardId: DASHBOARD_ID,
          candidateName: name,
          action: value,
        },
      },
      '*',
    )
  }

  function ensureActionCells(table, statusIdx, nameIdx) {
    var rows = table.querySelectorAll('tbody tr')
    rows.forEach(function (tr) {
      if (tr.children.length <= statusIdx) return // e.g. a colspan "no results" row

      var existing = tr.querySelector('[' + ACTION_ATTR + ']')
      if (existing) {
        var storedName = existing.getAttribute(ACTION_NAME_ATTR)
        var known = storedName
          ? actionValuesByName[storedName.toLowerCase()]
          : undefined
        if (known !== undefined && existing.value !== (known || '')) {
          existing.value = known || ''
          applyActionStyle(existing)
        }
        return
      }

      var name = extractRowIdentity(tr, nameIdx)
      var td = document.createElement('td')
      var select = document.createElement('select')
      select.setAttribute(ACTION_ATTR, '')
      if (name) select.setAttribute(ACTION_NAME_ATTR, name)
      populateActionOptions(select)
      select.addEventListener('change', handleActionChange)
      td.appendChild(select)

      var refNode = tr.children[statusIdx + 1] || null
      if (refNode) tr.insertBefore(td, refNode)
      else tr.appendChild(td)

      var knownValue = name ? actionValuesByName[name.toLowerCase()] : undefined
      if (knownValue) select.value = knownValue
      applyActionStyle(select)
    })
  }

  function syncActionColumns() {
    if (!ACTION_OPTIONS.length) return // config not delivered yet
    document.querySelectorAll('table').forEach(function (table) {
      var headerCells = getHeaderCells(table)
      var statusIdx = findColumnIndex(headerCells, isStatusHeader)
      if (statusIdx === -1) return
      var nameIdx = findColumnIndex(headerCells, isNameHeader)
      ensureActionHeader(table, statusIdx)
      ensureActionCells(table, statusIdx, nameIdx)
    })
  }

  var syncScheduled = false
  function scheduleSyncActionColumns() {
    if (syncScheduled) return
    syncScheduled = true
    window.requestAnimationFrame(function () {
      syncScheduled = false
      syncActionColumns()
    })
  }

  function init() {
    injectBaseStyles()

    // Some uploaded dashboards render/re-render their whole table body from
    // their own script (filters, sorting, search) — anything we inject gets
    // wiped when that happens. Re-run the (idempotent) sync on every DOM
    // change so the Action column survives those re-renders.
    new MutationObserver(scheduleSyncActionColumns).observe(document.body, {
      childList: true,
      subtree: true,
    })

    window.addEventListener('message', function (event) {
      var data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'longlist:init-config') {
        STATUS_OPTIONS = Array.isArray(data.statusOrder) ? data.statusOrder : []
        STATUS_STYLES = data.statusStyles || {}
        ACTION_OPTIONS = Array.isArray(data.actionOrder) ? data.actionOrder : []
        ACTION_STYLES = data.actionStyles || {}
        wireSelects()
        syncActionColumns()
        return
      }

      if (
        data.type === 'longlist:init-statuses' &&
        Array.isArray(data.statuses)
      ) {
        data.statuses.forEach(function (entry) {
          if (entry.candidateName) {
            actionValuesByName[entry.candidateName.toLowerCase()] =
              entry.action || null
          }
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
        syncActionColumns()
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

      if (data.type === 'longlist:action-ack') {
        document
          .querySelectorAll('[' + ACTION_ATTR + ']')
          .forEach(function (select) {
            if (select.getAttribute(ACTION_NAME_ATTR) === data.candidateName) {
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
