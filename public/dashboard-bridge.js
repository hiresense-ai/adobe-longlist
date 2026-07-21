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

  function injectBaseStyles() {
    var style = document.createElement('style')
    style.textContent =
      '[' +
      ATTR_STATUS +
      '], [' +
      ACTION_ATTR +
      '] { transition: background-color 220ms ease, border-color 220ms ease, color 220ms ease; }' +
      '[' +
      ATTR_STATUS +
      ']:focus-visible, [' +
      ACTION_ATTR +
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

  function applyActionStyle(select) {
    if (!select.value) {
      select.style.backgroundColor = ''
      select.style.color = ''
      select.style.borderColor = ''
      select.style.borderWidth = ''
      select.style.borderStyle = ''
      select.style.borderRadius = ''
      select.style.padding = ''
      select.style.fontWeight = ''
      select.style.outlineColor = ''
      select.style.cursor = 'pointer'
      return
    }
    var styles = ACTION_STYLES[select.value]
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
