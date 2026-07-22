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
  var ACTION_CELL_ATTR = 'data-longlist-action-cell'
  var ACTION_HEADER_ATTR = 'data-longlist-action-header'
  var ACTION_NAME_ATTR = 'data-longlist-action-name'
  var ACTION_LABEL_ATTR = 'data-longlist-action-label'
  var ACTION_CHEVRON_ATTR = 'data-longlist-action-chevron'

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
      '] { transition: background-color 220ms ease, border-color 220ms ease, color 220ms ease; }' +
      '[' +
      ATTR_STATUS +
      ']:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: 2px; }' +
      // Action control: a small enterprise-style combobox button (not a
      // native <select> — its popup can't be restyled in any browser).
      // Only box-model/typography/chrome live here; background/text/border
      // colors are always set per-selected-value via inline style in
      // applyActionStyle(), never here.
      '[' +
      ACTION_ATTR +
      '] {' +
      'all: unset; box-sizing: border-box; display: inline-flex; align-items: center;' +
      'justify-content: space-between; gap: 8px;' +
      'height: 35px; width: 200px;' +
      'padding: 0 10px;' +
      'border-radius: 8px; border: 1px solid transparent;' +
      'font-weight: 500; font-size: 13px; font-family: inherit; line-height: 1;' +
      'cursor: pointer;' +
      'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.04);' +
      'transition: background-color 200ms ease, border-color 200ms ease, color 200ms ease, box-shadow 200ms ease;' +
      '}' +
      '[' +
      ACTION_ATTR +
      ']:hover { box-shadow: 0 2px 5px 0 rgba(0,0,0,0.08); }' +
      '[' +
      ACTION_ATTR +
      ']:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--action-ring-color, rgba(0,0,0,0.18)); }' +
      '[' +
      ACTION_LABEL_ATTR +
      '] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; text-align: left; }' +
      '[' +
      ACTION_CHEVRON_ATTR +
      '] { flex-shrink: 0; transition: transform 200ms ease; opacity: 0.6; }' +
      '[' +
      ACTION_ATTR +
      '][aria-expanded="true"] [' +
      ACTION_CHEVRON_ATTR +
      '] { transform: rotate(180deg); }' +
      '.ll-action-option:hover, .ll-action-option[data-active="true"] { background: var(--ll-hover-bg, rgba(0,0,0,0.05)); }'
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

  function showFeedback(el, ok, message) {
    var badge =
      el.parentElement &&
      el.parentElement.querySelector('[data-longlist-feedback]')
    if (!badge) {
      badge = document.createElement('span')
      badge.setAttribute('data-longlist-feedback', '')
      badge.style.marginLeft = '8px'
      badge.style.fontFamily = 'inherit'
      badge.style.fontSize = '12px'
      badge.style.borderRadius = '9999px'
      badge.style.padding = '2px 8px'
      badge.style.transition = 'background-color 220ms ease, color 220ms ease'
      el.insertAdjacentElement('afterend', badge)
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
  // Action column — injected at runtime as the LAST column of any table
  // that has a "Status" column (e.g. an Active/Passive availability tag).
  // That existing column is only ever read (to detect this is a candidate
  // table), never modified. Rendered as a custom button + floating listbox
  // rather than a native <select>, since a native select's open popup
  // cannot be restyled (rounded corners / shadow / hover / spacing) in any
  // browser. Every interaction on the trigger stops propagation so it can
  // never bubble into a dashboard's own row-click handler (e.g. one that
  // opens a "candidate details" modal) — the popup itself is portaled to
  // <body>, so it's never a descendant of the row in the first place.
  // ---------------------------------------------------------------------

  // Uploaded dashboards are static HTML documents with a fixed light
  // design — they never change appearance when the host app's own theme
  // toggle changes. Coloring the Action control from the app's theme (as
  // the Status select does) previously produced a solid dark-navy fill
  // whenever the app was in dark mode, clashing badly with the always-light
  // table around it. So, unlike Status, Action always uses its light
  // palette regardless of currentTheme.
  var UNSET_ACTION_PALETTE = {
    background: '#FFFFFF',
    text: '#6B7280',
    border: '#9CA3AF',
  }

  var actionUidCounter = 0
  var openPopupEl = null
  var openTriggerEl = null
  var closeOpenPopup = null

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

  function stickyCellStyle(el, isHeader) {
    el.style.position = 'sticky'
    el.style.right = '0'
    el.style.zIndex = isHeader ? '3' : '2'
    // Deliberately no background here: the row/header's own background
    // (default, hover, selected, whatever theme the dashboard uses) is
    // painted behind every other cell in the row already — this cell must
    // stay transparent to show the same thing, rather than looking
    // detached with its own fixed color. Only the trigger button itself
    // (applyActionStyle) keeps its own background.
    el.style.background = 'transparent'
    el.style.boxShadow =
      '-8px 0 8px -8px rgba(0,0,0,' + (isHeader ? '0.12' : '0.1') + ')'
  }

  function ensureActionHeader(table) {
    var headRow = (table.querySelector('thead') || table).querySelector('tr')
    if (!headRow) return
    if (headRow.querySelector('[' + ACTION_HEADER_ATTR + ']')) return
    var th = document.createElement('th')
    th.setAttribute(ACTION_HEADER_ATTR, '')
    th.textContent = 'Action'
    stickyCellStyle(th, true)
    headRow.appendChild(th)
  }

  function extractRowIdentity(tr, nameIdx) {
    var explicit = tr.getAttribute(ATTR_NAME)
    if (explicit) return explicit.trim()
    if (nameIdx === -1) return null
    var cell = tr.children[nameIdx]
    if (!cell) return null
    return (cell.textContent || '').trim()
  }

  function getActionValue(trigger) {
    return trigger.getAttribute('data-value') || ''
  }

  function setActionValue(trigger, value) {
    trigger.setAttribute('data-value', value || '')
    var label = trigger.querySelector('[' + ACTION_LABEL_ATTR + ']')
    if (label) label.textContent = value || 'Select Action'
    trigger.title = value || 'Select Action'
    applyActionStyle(trigger)
  }

  // Box shape/typography live in the injected stylesheet (shared, static);
  // this only sets the three colors that vary by selected value —
  // background, text, border — plus a CSS custom property so the
  // :focus-visible ring in that same stylesheet can match the current
  // color without duplicating the palette lookup.
  function applyActionStyle(trigger) {
    var value = getActionValue(trigger)
    var styles = value ? ACTION_STYLES[value] : null
    var palette = (styles && styles.light) || UNSET_ACTION_PALETTE
    trigger.style.backgroundColor = palette.background
    trigger.style.color = palette.text
    trigger.style.borderColor = palette.border
    trigger.style.setProperty('--action-ring-color', palette.border)
  }

  function commitActionSelection(trigger, value) {
    setActionValue(trigger, value)
    var name = trigger.getAttribute(ACTION_NAME_ATTR)
    if (!name) return
    actionValuesByName[name.toLowerCase()] = value || null
    window.parent.postMessage(
      {
        type: 'longlist:action-update',
        payload: {
          dashboardId: DASHBOARD_ID,
          candidateName: name,
          action: value || null,
        },
      },
      '*',
    )
  }

  function closeActionPopup() {
    if (!openPopupEl) return
    var popup = openPopupEl
    var cleanup = closeOpenPopup
    openPopupEl = null
    openTriggerEl = null
    closeOpenPopup = null
    if (cleanup) cleanup()
    if (popup.parentNode) popup.parentNode.removeChild(popup)
    document
      .querySelectorAll('[' + ACTION_ATTR + '][aria-expanded="true"]')
      .forEach(function (btn) {
        btn.setAttribute('aria-expanded', 'false')
      })
  }

  function openActionPopup(trigger) {
    closeActionPopup()

    var rect = trigger.getBoundingClientRect()
    var currentValue = getActionValue(trigger)
    var optionValues = [''].concat(ACTION_OPTIONS)

    var popup = document.createElement('div')
    popup.setAttribute('role', 'listbox')
    popup.setAttribute('aria-label', 'Action')
    popup.tabIndex = -1
    popup.id = trigger.id + '-listbox'
    popup.style.position = 'fixed'
    popup.style.zIndex = '2147483000'
    popup.style.width = rect.width + 'px'
    popup.style.overflowY = 'auto'
    popup.style.boxSizing = 'border-box'
    popup.style.padding = '6px'
    popup.style.borderRadius = '10px'
    popup.style.outline = 'none'
    popup.style.fontFamily = 'inherit'
    popup.style.background = '#FFFFFF'
    popup.style.border = '1px solid #E5E7EB'
    popup.style.boxShadow =
      '0 8px 16px -4px rgba(0,0,0,0.12), 0 2px 4px -2px rgba(0,0,0,0.08)'
    popup.style.setProperty('--ll-hover-bg', '#F3F4F6')

    // window.innerHeight here is the iframe's OWN viewport — the true hard
    // clip boundary, since content inside a sandboxed iframe can never
    // render outside the iframe's own box no matter how it's positioned.
    // Rather than a fixed maxHeight + binary flip, pick whichever side (up
    // or down) has more room, then cap maxHeight to what that side actually
    // has — otherwise a short iframe would clip part of the list with no
    // way to scroll to it, since the clipping happens at the iframe edge,
    // outside the popup's own overflow:auto box.
    var GAP = 4
    var EDGE_MARGIN = 8
    var spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE_MARGIN
    var spaceAbove = rect.top - GAP - EDGE_MARGIN
    var openUpward = spaceBelow < 160 && spaceAbove > spaceBelow
    var maxHeight = Math.max(
      120,
      Math.min(320, openUpward ? spaceAbove : spaceBelow),
    )
    popup.style.maxHeight = maxHeight + 'px'
    if (openUpward) {
      popup.style.bottom = window.innerHeight - rect.top + GAP + 'px'
    } else {
      popup.style.top = rect.bottom + GAP + 'px'
    }
    popup.style.left = rect.left + 'px'

    var optionEls = optionValues.map(function (value, i) {
      var opt = document.createElement('div')
      opt.className = 'll-action-option'
      opt.setAttribute('role', 'option')
      opt.id = trigger.id + '-opt-' + i
      opt.textContent = value || 'Select Action'
      opt.style.padding = '8px 10px'
      opt.style.borderRadius = '8px'
      opt.style.fontSize = '13px'
      opt.style.cursor = 'pointer'
      opt.style.whiteSpace = 'normal'
      opt.style.wordBreak = 'break-word'
      opt.style.color = value ? '#111827' : '#6B7280'
      opt.setAttribute(
        'aria-selected',
        value === currentValue ? 'true' : 'false',
      )
      opt.addEventListener('mouseenter', function () {
        setActiveOption(i)
      })
      opt.addEventListener('click', function (e) {
        e.stopPropagation()
        commitActionSelection(trigger, value)
        closeActionPopup()
        trigger.focus()
      })
      popup.appendChild(opt)
      return opt
    })

    function setActiveOption(index) {
      optionEls.forEach(function (opt, i) {
        opt.setAttribute('data-active', i === index ? 'true' : 'false')
      })
      popup.setAttribute('aria-activedescendant', optionEls[index].id)
    }

    var initialIndex = Math.max(0, optionValues.indexOf(currentValue))
    setActiveOption(initialIndex)

    document.body.appendChild(popup)
    // Keep the current selection visible without an animated jump, in case
    // it's scrolled out of the now-height-capped view.
    optionEls[initialIndex].scrollIntoView({ block: 'nearest' })
    popup.focus()
    trigger.setAttribute('aria-expanded', 'true')

    function activeIndex() {
      for (var i = 0; i < optionEls.length; i++) {
        if (optionEls[i].getAttribute('data-active') === 'true') return i
      }
      return 0
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeActionPopup()
        trigger.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        var next = Math.min(optionEls.length - 1, activeIndex() + 1)
        setActiveOption(next)
        optionEls[next].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        var prev = Math.max(0, activeIndex() - 1)
        setActiveOption(prev)
        optionEls[prev].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActiveOption(0)
        optionEls[0].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'End') {
        e.preventDefault()
        setActiveOption(optionEls.length - 1)
        optionEls[optionEls.length - 1].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'PageDown') {
        e.preventDefault()
        var pageNext = Math.min(optionEls.length - 1, activeIndex() + 4)
        setActiveOption(pageNext)
        optionEls[pageNext].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'PageUp') {
        e.preventDefault()
        var pagePrev = Math.max(0, activeIndex() - 4)
        setActiveOption(pagePrev)
        optionEls[pagePrev].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        commitActionSelection(trigger, optionValues[activeIndex()])
        closeActionPopup()
        trigger.focus()
      } else if (e.key === 'Tab') {
        // Don't preventDefault — close and refocus the trigger first so the
        // browser's native Tab handling continues from the button's real
        // position in the row, not from the popup (a detached body child).
        closeActionPopup()
        trigger.focus()
      }
    }
    popup.addEventListener('keydown', onKeydown)

    function onOutsideClick(e) {
      if (popup.contains(e.target) || trigger.contains(e.target)) return
      closeActionPopup()
    }
    // Deferred so the same click that opened the popup doesn't immediately
    // close it again (the trigger's own click handler runs first).
    window.setTimeout(function () {
      document.addEventListener('click', onOutsideClick, true)
    }, 0)

    // Closes the popup if some ANCESTOR of the trigger scrolls (which would
    // move the trigger out from under this fixed-position popup) — but a
    // capture-phase listener on window sees every scroll event in the
    // document, including the popup's own internal list scrolling, so it
    // must ignore scrolls that originated inside the popup itself. Getting
    // this wrong closes the popup the instant it's scrolled at all — by
    // wheel, trackpad, dragging the scrollbar, or the keyboard handlers'
    // own scrollIntoView calls above — which looks exactly like "scrolling
    // doesn't work."
    function onScrollOrResize(e) {
      if (e && e.type === 'scroll' && e.target && popup.contains(e.target)) {
        return
      }
      closeActionPopup()
    }
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)

    // While open, block wheel/touch scrolling of anything OUTSIDE the popup
    // (the dashboard's own table/page) so the trigger never moves under an
    // open popup — without this, the underlying table or page could still
    // scroll via mouse wheel or a touchpad even though the popup itself
    // isn't the target. Scrolling the popup's own content is unaffected,
    // since events that target it (or land inside it) are left alone.
    function blockOutsideScroll(e) {
      if (popup.contains(e.target)) return
      e.preventDefault()
    }
    document.addEventListener('wheel', blockOutsideScroll, {
      passive: false,
      capture: true,
    })
    document.addEventListener('touchmove', blockOutsideScroll, {
      passive: false,
      capture: true,
    })

    openPopupEl = popup
    openTriggerEl = trigger
    closeOpenPopup = function () {
      document.removeEventListener('click', onOutsideClick, true)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      document.removeEventListener('wheel', blockOutsideScroll, {
        capture: true,
      })
      document.removeEventListener('touchmove', blockOutsideScroll, {
        capture: true,
      })
      popup.removeEventListener('keydown', onKeydown)
    }
  }

  var STOP_PROPAGATION_EVENTS = [
    'click',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'touchstart',
    'touchend',
  ]

  function createActionTrigger(name) {
    actionUidCounter += 1
    var button = document.createElement('button')
    button.type = 'button'
    button.id = 'll-action-' + actionUidCounter
    button.setAttribute(ACTION_ATTR, '')
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    if (name) {
      button.setAttribute(ACTION_NAME_ATTR, name)
      button.setAttribute('aria-label', 'Action for ' + name)
    }

    var label = document.createElement('span')
    label.setAttribute(ACTION_LABEL_ATTR, '')
    button.appendChild(label)

    var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    chevron.setAttribute(ACTION_CHEVRON_ATTR, '')
    chevron.setAttribute('width', '14')
    chevron.setAttribute('height', '14')
    chevron.setAttribute('viewBox', '0 0 24 24')
    chevron.setAttribute('fill', 'none')
    chevron.setAttribute('stroke', 'currentColor')
    chevron.setAttribute('stroke-width', '2.5')
    chevron.setAttribute('stroke-linecap', 'round')
    chevron.setAttribute('stroke-linejoin', 'round')
    var polyline = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polyline',
    )
    polyline.setAttribute('points', '6 9 12 15 18 9')
    chevron.appendChild(polyline)
    button.appendChild(chevron)

    // Never let interacting with this control reach an ancestor row's own
    // click handler (e.g. one that opens a candidate-details modal).
    STOP_PROPAGATION_EVENTS.forEach(function (evt) {
      button.addEventListener(evt, function (e) {
        e.stopPropagation()
      })
    })

    button.addEventListener('click', function () {
      if (button.getAttribute('aria-expanded') === 'true') {
        closeActionPopup()
      } else {
        openActionPopup(button)
      }
    })

    button.addEventListener('keydown', function (e) {
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Enter' ||
        e.key === ' '
      ) {
        e.preventDefault()
        if (button.getAttribute('aria-expanded') !== 'true') {
          openActionPopup(button)
        }
      }
    })

    return button
  }

  function ensureActionCells(table, nameIdx, minCells) {
    var rows = table.querySelectorAll('tbody tr')
    rows.forEach(function (tr) {
      if (tr.children.length < minCells) return // e.g. a colspan "no results" row

      var existingTd = tr.querySelector('[' + ACTION_CELL_ATTR + ']')
      if (existingTd) {
        var trigger = existingTd.querySelector('[' + ACTION_ATTR + ']')
        if (!trigger) return
        var storedName = trigger.getAttribute(ACTION_NAME_ATTR)
        var known = storedName
          ? actionValuesByName[storedName.toLowerCase()]
          : undefined
        if (known !== undefined && getActionValue(trigger) !== (known || '')) {
          setActionValue(trigger, known || '')
        }
        return
      }

      var name = extractRowIdentity(tr, nameIdx)
      var td = document.createElement('td')
      td.setAttribute(ACTION_CELL_ATTR, '')
      stickyCellStyle(td, false)

      var trigger = createActionTrigger(name)
      td.appendChild(trigger)
      tr.appendChild(td)

      var knownValue = name ? actionValuesByName[name.toLowerCase()] : undefined
      setActionValue(trigger, knownValue || '')
    })
  }

  function syncActionColumns() {
    if (!ACTION_OPTIONS.length) return // config not delivered yet
    document.querySelectorAll('table').forEach(function (table) {
      // Read header cells BEFORE ensureActionHeader() runs, and use
      // statusIdx (not the header's total length) as the "is this a real
      // data row" threshold below: the header permanently gains our Action
      // column after the first sync, but a freshly re-rendered <tbody> row
      // (e.g. after the dashboard's own filter/sort) always starts without
      // one — comparing against the inflated total would wrongly treat
      // every legitimate row as a short/placeholder row forever after.
      var headerCells = getHeaderCells(table)
      var statusIdx = findColumnIndex(headerCells, isStatusHeader)
      if (statusIdx === -1) return
      var nameIdx = findColumnIndex(headerCells, isNameHeader)
      ensureActionHeader(table)
      ensureActionCells(table, nameIdx, statusIdx + 1)
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

  // ---------------------------------------------------------------------
  // Height reporting — lets the host size the iframe to the dashboard's
  // own natural content height instead of giving it a fixed viewport
  // height and letting it scroll internally. Uses ResizeObserver rather
  // than only re-measuring from the MutationObserver above, since it also
  // catches height changes that aren't caused by a DOM mutation at all —
  // e.g. the browser window narrowing and the table's own text wrapping
  // onto more lines.
  // ---------------------------------------------------------------------

  function reportHeight() {
    var height = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    )
    window.parent.postMessage(
      { type: 'longlist:resize', dashboardId: DASHBOARD_ID, height: height },
      '*',
    )
  }

  var heightReportScheduled = false
  function scheduleReportHeight() {
    if (heightReportScheduled) return
    heightReportScheduled = true
    window.requestAnimationFrame(function () {
      heightReportScheduled = false
      reportHeight()
    })
  }

  // ---------------------------------------------------------------------
  // Candidate Details modal — the real uploaded dashboards render this as
  // a pre-existing `<div id="detail" class="detail hidden">` overlay
  // (position: fixed; inset: 0; display: flex; align-items: center;
  // justify-content: center — its content flex-centered inside it),
  // toggled open/closed purely by adding/removing the `hidden` class —
  // never modified here, just watched.
  //
  // Now that this iframe is sized to its full content height rather than
  // a fixed viewport height (see height reporting above), position: fixed
  // inside it is fixed relative to the iframe's own — now much taller —
  // internal viewport, not whatever part of the browser window the page
  // is scrolled to. Concretely: flex-centering inside a full-inset fixed
  // overlay always centers at exactly half the IFRAME's total height,
  // regardless of which row was clicked or where the outer page happens
  // to be scrolled.
  //
  // Rather than scrolling the outer page to chase that fixed point (which
  // moves the page, and the ask here is specifically that it never does),
  // the host instead continuously reports which slice of THIS iframe's
  // own coordinate space is currently visible in the browser window (see
  // longlist:viewport-slice below). On open, that slice is applied as
  // this overlay's own inset — collapsing its `inset: 0` (the whole
  // iframe) down to just the currently-visible rectangle — and the
  // dashboard's own untouched flex-centering does the rest, centering the
  // card within THAT rectangle instead of the whole iframe. The outer
  // page's scroll position never changes; only this element's own inline
  // style is touched, and only for as long as the modal is open.
  // ---------------------------------------------------------------------

  var latestViewportSlice = null

  function applyModalViewportSlice(modal) {
    if (!latestViewportSlice) return
    modal.style.top = latestViewportSlice.top + 'px'
    modal.style.height = latestViewportSlice.height + 'px'
    modal.style.left = '0px'
    modal.style.right = '0px'
    modal.style.bottom = 'auto'
  }

  function resetModalViewportSlice(modal) {
    modal.style.top = ''
    modal.style.height = ''
    modal.style.left = ''
    modal.style.right = ''
    modal.style.bottom = ''
  }

  function watchCandidateDetailModal() {
    var modal = document.getElementById('detail')
    if (!modal || !modal.classList.contains('detail')) return

    function isOpen() {
      return !modal.classList.contains('hidden')
    }

    var wasOpen = isOpen()

    new MutationObserver(function () {
      var open = isOpen()
      if (open === wasOpen) return
      wasOpen = open

      if (open) {
        applyModalViewportSlice(modal)
        window.parent.postMessage({ type: 'longlist:modal-open' }, '*')
      } else {
        resetModalViewportSlice(modal)
        window.parent.postMessage({ type: 'longlist:modal-close' }, '*')
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] })
  }

  function init() {
    injectBaseStyles()
    watchCandidateDetailModal()

    // Some uploaded dashboards render/re-render their whole table body from
    // their own script (filters, sorting, search) — anything we inject gets
    // wiped when that happens. Re-run the (idempotent) sync on every DOM
    // change so the Action column survives those re-renders. Also close any
    // open popup, since the row it belongs to may no longer exist.
    new MutationObserver(function () {
      // Only force-close the popup if the row it belongs to was actually
      // wiped out by a re-render — not on every mutation, since appending
      // the popup itself (or the action cells) to the document is itself a
      // mutation this same observer sees.
      if (openTriggerEl && !document.body.contains(openTriggerEl)) {
        closeActionPopup()
      }
      scheduleSyncActionColumns()
      scheduleReportHeight()
    }).observe(document.body, {
      childList: true,
      subtree: true,
    })

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(scheduleReportHeight).observe(document.documentElement)
    } else {
      window.addEventListener('resize', scheduleReportHeight)
    }

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
          .forEach(function (trigger) {
            if (trigger.getAttribute(ACTION_NAME_ATTR) === data.candidateName) {
              showFeedback(trigger, data.success, data.error)
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

      if (
        data.type === 'longlist:viewport-slice' &&
        typeof data.top === 'number' &&
        typeof data.height === 'number'
      ) {
        latestViewportSlice = { top: data.top, height: data.height }
        var openModal = document.getElementById('detail')
        if (openModal && !openModal.classList.contains('hidden')) {
          applyModalViewportSlice(openModal)
        }
      }
    })

    window.parent.postMessage(
      { type: 'longlist:ready', dashboardId: DASHBOARD_ID },
      '*',
    )
    scheduleReportHeight()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
