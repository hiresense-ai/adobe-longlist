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

  // =====================================================================
  // File download bridge.
  //
  // This iframe is sandboxed without allow-same-origin (deliberately —
  // see DashboardFrame.tsx), so its document has an opaque origin. Any
  // URL.createObjectURL() call made in here therefore returns a
  // `blob:null/<uuid>` URL rather than `blob:<origin>/<uuid>`, and the
  // browser will not resolve an opaque-origin blob as a download target.
  // The dashboard's own export code runs to completion and throws
  // nothing — the file simply never arrives. Confirmed by instrumenting
  // the running app: the click reaches the button, the CSV string and
  // Blob are built correctly, createObjectURL returns blob:null/..., and
  // anchor.click() returns without an exception, with no download.
  //
  // Rather than weakening the sandbox (allow-same-origin plus the
  // already-present allow-scripts would let untrusted uploaded HTML
  // reach this app's own session), the download is re-routed through the
  // parent, which has a real origin: intercept the anchor click here,
  // hand the file's bytes up over the existing postMessage bridge, and
  // let the parent mint the object URL and save the file.
  //
  // This works by DOM/prototype observation only, so it needs no
  // cooperation from — and no edit to — any uploaded dashboard's own
  // script (whose functions are private to its own closure and
  // unreachable from here). Every dashboard already in Storage is fixed
  // by this without being re-uploaded. Dashboards that would rather send
  // the export explicitly can post a longlist:export-file message
  // themselves instead; both paths land in the same parent handler.
  // =====================================================================

  // Remembers the Blob behind each object URL this document mints, so an
  // intercepted download can recover the actual bytes. Bounded: the
  // dashboard never revokes its export URLs, so without a cap this would
  // pin every exported CSV in memory for the life of the page.
  var MAX_TRACKED_BLOBS = 8
  var trackedBlobUrls = []
  var blobsByUrl = Object.create(null)

  var origCreateObjectURL = URL.createObjectURL
  URL.createObjectURL = function (obj) {
    var url = origCreateObjectURL.call(URL, obj)
    if (typeof Blob !== 'undefined' && obj instanceof Blob) {
      blobsByUrl[url] = obj
      trackedBlobUrls.push(url)
      while (trackedBlobUrls.length > MAX_TRACKED_BLOBS) {
        delete blobsByUrl[trackedBlobUrls.shift()]
      }
    }
    return url
  }

  var origRevokeObjectURL = URL.revokeObjectURL
  URL.revokeObjectURL = function (url) {
    if (blobsByUrl[url]) {
      delete blobsByUrl[url]
      var i = trackedBlobUrls.indexOf(url)
      if (i !== -1) trackedBlobUrls.splice(i, 1)
    }
    return origRevokeObjectURL.call(URL, url)
  }

  // Sends the file's RAW BYTES, never a decoded string. Decoding to text
  // would silently strip a leading UTF-8 BOM (TextDecoder/Blob.text()
  // consume it by default), and these exports lead with one precisely so
  // Excel detects UTF-8 and renders non-ASCII candidate names correctly.
  // Passing the ArrayBuffer through keeps the saved file byte-identical
  // to what the dashboard built, whatever its encoding or content type.
  function sendFileToParent(filename, bytes, mimeType) {
    window.parent.postMessage(
      {
        type: 'longlist:export-file',
        dashboardId: DASHBOARD_ID,
        filename: filename,
        bytes: bytes,
        mimeType: mimeType || 'text/csv;charset=utf-8;',
      },
      '*',
    )
  }

  var origAnchorClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    var href = this.getAttribute('href') || ''
    // Only download-intent clicks on this document's own blobs are
    // re-routed. Ordinary links (the dashboard's LinkedIn/GitHub anchors,
    // in-page anchors, http(s) downloads) keep their native behavior.
    if (!this.hasAttribute('download') || href.indexOf('blob:') !== 0) {
      return origAnchorClick.call(this)
    }

    var blob = blobsByUrl[this.href] || blobsByUrl[href]
    var filename = this.getAttribute('download') || 'download.csv'

    if (!blob) {
      // URL wasn't minted in this document (or was already evicted) —
      // nothing to forward, so let the browser do whatever it would
      // have done rather than silently swallowing the click.
      return origAnchorClick.call(this)
    }

    var mimeType = blob.type
    if (blob.arrayBuffer) {
      blob.arrayBuffer().then(function (buffer) {
        sendFileToParent(filename, buffer, mimeType)
      })
    } else {
      var reader = new FileReader()
      reader.onload = function () {
        sendFileToParent(filename, reader.result, mimeType)
      }
      reader.readAsArrayBuffer(blob)
    }

    // Deliberately does NOT call through: the native click is what
    // silently fails here, and letting it run would risk a duplicate
    // (or partial) download in any browser where it does something.
    return undefined
  }

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
      '.ll-action-option:hover, .ll-action-option[data-active="true"] { background: var(--ll-hover-bg, rgba(0,0,0,0.05)); }' +
      // -----------------------------------------------------------------
      // Full-width layout on large displays.
      //
      // The uploaded dashboards cap their three structural containers at
      // `max-width: 1400px; margin: 0 auto`, from back when they were
      // standalone files opened directly in a browser tab. Inside this
      // app the iframe already spans the full viewport width at every
      // resolution (100vw full-bleed wrapper -> w-full container ->
      // size-full iframe, no fixed widths anywhere), so that 1400px cap
      // is the only thing left constraining the layout: at 1366px the
      // viewport is narrower than the cap and the dashboard appears to
      // fill the screen, while at 1920/2560/4K it stays 1400px wide and
      // centered, with the extra space showing as empty gutters.
      //
      // Overriding it here rather than in the uploaded HTML keeps those
      // files untouched and fixes every dashboard already in Storage
      // without re-uploading any of them.
      //
      // Deliberately scoped to those layout containers only. Two other
      // max-widths in the same stylesheet are intentional and left
      // alone: `.dcard` (660px) keeps the Candidate Details modal a
      // readable card instead of stretching it across a 4K screen, and
      // `.sec-sub` (85ch) keeps prose at a readable measure.
      '.hz, .tabs, .main { max-width: 100% !important; }' +
      // The template's own padding is tuned for a 1400px column; on a
      // very wide screen a little more breathing room keeps content off
      // the bezel without reintroducing a hard cap.
      '@media (min-width: 1600px) { .hz, .main { padding-left: 48px !important; padding-right: 48px !important; } .tabs { padding-left: 36px !important; padding-right: 36px !important; } }' +
      // Candidate Explorer pagination bar — appended after the table by
      // syncTablePagination() below. Styled to match the dashboard's own
      // design tokens (--accent/--gray/--gb/--ink) rather than this
      // bridge's own palette, so it reads as native to the dashboard.
      '.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 2px 4px; font-size: 13px; color: var(--gray); }' +
      '.pg-lbl { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }' +
      '.pg-lbl select { font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--gb); border-radius: 8px; background: #fff; color: var(--ink); cursor: pointer; }' +
      '.pg-mid { font-weight: 600; color: var(--ink); }' +
      '.pg-right { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }' +
      '.pg-nav, .pg-num { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--gb); background: #fff; color: var(--ink); border-radius: 8px; cursor: pointer; transition: border-color .15s ease, color .15s ease; }' +
      '.pg-num { min-width: 34px; }' +
      '.pg-nav[disabled] { opacity: .45; cursor: default; }' +
      '.pg-num.on { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 700; }' +
      '.pg-num:hover:not(.on), .pg-nav:hover:not([disabled]) { border-color: var(--accent); color: var(--accent); }' +
      '.pg-gap { padding: 0 2px; color: var(--gray); }' +
      '@media (max-width: 820px) { .pager { justify-content: center; text-align: center; } }'
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
  // Candidate Explorer pagination.
  //
  // The dashboard's own render() hard-caps at view.slice(0,300) and prints
  // a static "Showing first 300 of X" notice — rows past 300 are simply
  // never in the DOM. window.__ROWS is the SAME array apply() assigns
  // right before calling render() (`window.__ROWS=view; render(); ...`):
  // the complete, already-filtered-and-sorted result set. That's the only
  // thing read here. Filtering, searching and sorting live entirely
  // inside apply()/view/F/sortK, which are never called, read, or
  // reimplemented — this only ever reads the array apply() already
  // produced, never window.__ROWS's contents in a way that could get out
  // of sync with them.
  //
  // render() itself, and the private per-cell helpers it uses
  // (lvlCell/bestTag/badge/liHref/escH), live inside the dashboard's own
  // closure — a separate <script> tag, not a shared scope, so none of
  // them can be called from here. The cell markup below is reconstructed
  // rather than duplicated: every value it displays comes from
  // window.__ROWS itself, and the two small lookup tables it needs
  // (level names, seniority labels) are pulled out of the dashboard's own
  // inline script by regex rather than hardcoded, so they can never drift
  // from what the dashboard actually defines. Persona colors are
  // harvested from the dashboard's own already-rendered .persona-tag
  // elements the first time this runs (before this ever touches #tbody),
  // so they're read from its real output, not re-derived. All of this
  // was verified cell-by-cell against the live dashboard, not assumed.
  //
  // Reset-to-page-1 is driven purely by window.__ROWS's identity:
  // apply() assigns a brand-new array to it every time filtering, search,
  // or sort runs, so `rows !== state.lastRows` is true exactly when the
  // result set changed — no need to know *why* it changed, so filtering/
  // searching/sorting are only ever observed by reference, never touched.
  // ---------------------------------------------------------------------

  var PG_SIZES = [25, 50, 75, 100, 'all']
  var PG_DEFAULT_SIZE = 25
  var PG_ROW_ATTR = 'data-longlist-pg-row'
  var PG_PAGER_ATTR = 'data-longlist-pager'

  var pgStateByTable = new WeakMap()

  function getPgState(table) {
    var state = pgStateByTable.get(table)
    if (!state) {
      state = {
        page: 1,
        size: PG_DEFAULT_SIZE,
        lastRows: null,
        lookups: null,
        dirty: true,
      }
      pgStateByTable.set(table, state)
    }
    return state
  }

  // Gated on both the table's headers AND the actual shape of
  // window.__ROWS's own data — this table's row template is specific to
  // this dashboard generator's candidate fields (rank/name/tag/
  // best_persona), so it must never activate against some other table
  // that merely happens to have Name/Status-looking headers.
  function isExplorerTable(table) {
    var headerCells = getHeaderCells(table)
    if (!headerCells.length) return false
    if (findColumnIndex(headerCells, isNameHeader) === -1) return false
    if (findColumnIndex(headerCells, isStatusHeader) === -1) return false
    var rows = window.__ROWS
    if (!Array.isArray(rows)) return false
    // An empty result set (0 candidates, from a filter/search that
    // matched nothing) is a legitimate state to paginate, not a reason to
    // bail — there's just no sample row available to shape-check, so the
    // header match above is what this table's identity rests on here.
    if (!rows.length) return true
    var sample = rows[0]
    return (
      typeof sample.rank !== 'undefined' &&
      typeof sample.name === 'string' &&
      typeof sample.tag === 'string' &&
      typeof sample.best_persona !== 'undefined'
    )
  }

  function findInlineScriptContaining(needle) {
    var scripts = document.querySelectorAll('script:not([src])')
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].textContent.indexOf(needle) !== -1)
        return scripts[i].textContent
    }
    return ''
  }

  // Pulls a small literal object (e.g. `const LVLN={0:'Intern',...}`) out
  // of the dashboard's own script text instead of hardcoding its values
  // here, so a future change to these labels in the generator is picked
  // up automatically rather than silently going stale.
  function extractLiteralObject(source, varName) {
    var match = new RegExp(
      '(?:const|var|let)\\s+' + varName + '\\s*=\\s*(\\{[^{}]*\\})',
    ).exec(source)
    if (!match) return null
    try {
      // Parses a small literal object out of the dashboard's own script
      // text — code already trusted enough to be executing in this
      // sandboxed iframe; nothing new is being trusted here.
      return new Function('return (' + match[1] + ')')()
    } catch (e) {
      return null
    }
  }

  // Valid only against the dashboard's OWN native render (view.slice(0,300)):
  // the Nth <tr> there corresponds exactly to window.__ROWS[N]. Must run
  // before this file ever writes to #tbody itself, which is why
  // ensurePgLookups() only calls this on a table's very first sync.
  function harvestPersonaColors(table) {
    var colors = {}
    var rows = table.querySelectorAll('tbody tr')
    var data = window.__ROWS
    if (!data) return colors
    for (var i = 0; i < rows.length && i < data.length; i++) {
      var tagEl = rows[i].querySelector('.persona-tag')
      var persona = data[i] && data[i].best_persona
      if (tagEl && persona && !colors[persona] && tagEl.style.color) {
        colors[persona] = tagEl.style.color
      }
    }
    return colors
  }

  function ensurePgLookups(table, state) {
    if (state.lookups) return state.lookups
    var source = findInlineScriptContaining('function lvlCell')
    state.lookups = {
      levelNames: extractLiteralObject(source, 'LVLN') || {},
      seniorityLabels: extractLiteralObject(source, 'dl') || {},
      personaColors: harvestPersonaColors(table),
    }
    return state.lookups
  }

  function pgEscapeHtml(value) {
    return String(value == null ? '' : value).replace(
      /[&<>"']/g,
      function (ch) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[ch]
      },
    )
  }

  function pgLinkedInHref(c) {
    if (c.li_url) return c.li_url
    return (
      'https://www.linkedin.com/search/results/people/?keywords=' +
      encodeURIComponent((c.name || '') + ' ' + (c.company || ''))
    )
  }

  function pgLevelCellHtml(c, lookups) {
    var levelName = lookups.levelNames[c.level]
    var seniorityLabel = lookups.seniorityLabels[c.sen_dir] || ''
    return (
      '<span class="lvl">' +
      pgEscapeHtml(levelName != null ? levelName : '?') +
      '<span class="d d-' +
      pgEscapeHtml(c.sen_dir || '') +
      '">' +
      pgEscapeHtml(seniorityLabel) +
      '</span></span>'
    )
  }

  function pgBestFitCellHtml(c, lookups) {
    var color = lookups.personaColors[c.best_persona] || '#6B7280'
    return (
      '<span class="persona-tag" style="background:' +
      color +
      '22;color:' +
      color +
      '">' +
      pgEscapeHtml(c.best_persona) +
      ' · ' +
      pgEscapeHtml(c.best_persona_name || '') +
      '</span>'
    )
  }

  function pgRowHtml(c, lookups) {
    var flags =
      (c.product
        ? ' <span class="fitpill fit-Medium" title="Product company">P</span>'
        : '') +
      (c.premier
        ? ' <span class="fitpill fit-High" title="Premier institute">★</span>'
        : '')
    return (
      '<tr class="row" data-r="' +
      pgEscapeHtml(c.rank) +
      '" ' +
      PG_ROW_ATTR +
      '>' +
      '<td>' +
      pgEscapeHtml(c.rank) +
      '</td>' +
      '<td class="nm"><a href="' +
      pgEscapeHtml(pgLinkedInHref(c)) +
      '" target="_blank" rel="noopener">' +
      pgEscapeHtml(c.name) +
      '</a></td>' +
      '<td><b>' +
      pgEscapeHtml((c.headline || '–').slice(0, 44)) +
      '</b><br><span style="color:var(--gray)">' +
      pgEscapeHtml(c.company || '') +
      flags +
      '</span></td>' +
      '<td>' +
      pgEscapeHtml(c.loc || '–') +
      '</td>' +
      '<td>' +
      (c.yrs == null ? '–' : pgEscapeHtml(c.yrs)) +
      '</td>' +
      '<td>' +
      pgLevelCellHtml(c, lookups) +
      '</td>' +
      '<td><span class="badge b-' +
      pgEscapeHtml(c.tag) +
      '">' +
      pgEscapeHtml(c.tag) +
      '</span></td>' +
      '<td>' +
      pgBestFitCellHtml(c, lookups) +
      '</td>' +
      '</tr>'
    )
  }

  // The single function every page calculation goes through, so the row
  // slice, the footer text, and the nav controls can never disagree.
  // Clamps page as a side effect: the result set can shrink under
  // filtering, and the previously-current page may no longer exist.
  function pgCalc(total, page, size) {
    var all = size === 'all'
    var effectiveSize = all ? total || 1 : size
    var pages = Math.max(1, Math.ceil(total / effectiveSize))
    var clampedPage = Math.min(Math.max(1, page), pages)
    var start = total === 0 ? 0 : (clampedPage - 1) * effectiveSize
    var end = all ? total : Math.min(start + effectiveSize, total)
    return {
      total: total,
      all: all,
      pages: pages,
      page: clampedPage,
      start: start,
      end: end,
    }
  }

  // First/last always shown, current +/-1 around it, gaps elided.
  function pgPageNumbers(page, pages) {
    if (pages <= 7) {
      var seq = []
      for (var i = 1; i <= pages; i++) seq.push(i)
      return seq
    }
    var out = [1]
    var lo = Math.max(2, page - 1)
    var hi = Math.min(pages - 1, page + 1)
    if (lo > 2) out.push('…')
    for (var j = lo; j <= hi; j++) out.push(j)
    if (hi < pages - 1) out.push('…')
    out.push(pages)
    return out
  }

  function pgFooterMessage(calc) {
    var fmt = function (n) {
      return n.toLocaleString()
    }
    var noun = calc.total === 1 ? 'candidate' : 'candidates'
    if (calc.total === 0) return 'No candidates match the current filters'
    if (calc.all) {
      return 'Showing all ' + fmt(calc.total) + ' ' + noun
    }
    return (
      'Showing ' +
      fmt(calc.start + 1) +
      '–' +
      fmt(calc.end) +
      ' of ' +
      fmt(calc.total) +
      ' ' +
      noun
    )
  }

  function pgRenderPager(container, table, state, calc) {
    var nums =
      calc.total === 0
        ? ''
        : pgPageNumbers(calc.page, calc.pages)
            .map(function (n) {
              if (n === '…') return '<span class="pg-gap">…</span>'
              return (
                '<button type="button" class="pg-num' +
                (n === calc.page ? ' on' : '') +
                '" data-pg-page="' +
                n +
                '"' +
                (n === calc.page ? ' aria-current="page"' : '') +
                '>' +
                n +
                '</button>'
              )
            })
            .join('')

    container.innerHTML =
      '<div class="pg-left"><label class="pg-lbl">Rows per page ' +
      '<select data-pg-size aria-label="Rows per page">' +
      PG_SIZES.map(function (s) {
        return (
          '<option value="' +
          s +
          '"' +
          (String(s) === String(state.size) ? ' selected' : '') +
          '>' +
          (s === 'all' ? 'All' : s) +
          '</option>'
        )
      }).join('') +
      '</select></label></div>' +
      '<div class="pg-mid" role="status">' +
      pgEscapeHtml(pgFooterMessage(calc)) +
      '</div>' +
      '<div class="pg-right">' +
      '<button type="button" class="pg-nav" data-pg-nav="prev"' +
      (calc.page <= 1 || calc.total === 0 ? ' disabled' : '') +
      '>‹ Previous</button>' +
      nums +
      '<button type="button" class="pg-nav" data-pg-nav="next"' +
      (calc.page >= calc.pages || calc.total === 0 ? ' disabled' : '') +
      '>Next ›</button>' +
      '</div>'

    container.__pgTable = table
  }

  function ensurePagerContainer(table) {
    if (table.__pgPagerEl && table.__pgPagerEl.isConnected)
      return table.__pgPagerEl
    var el = document.createElement('div')
    el.className = 'pager'
    el.setAttribute(PG_PAGER_ATTR, '')
    table.parentNode.insertBefore(el, table.nextSibling)
    table.__pgPagerEl = el
    return el
  }

  function syncTablePagination(table) {
    if (!isExplorerTable(table)) return
    var rows = window.__ROWS
    if (!Array.isArray(rows)) return

    var state = getPgState(table)
    if (rows !== state.lastRows) {
      state.lastRows = rows
      state.page = 1
      state.dirty = true
    }
    if (!state.dirty) return

    var lookups = ensurePgLookups(table, state)
    var calc = pgCalc(rows.length, state.page, state.size)
    state.page = calc.page

    var tbody = table.querySelector('tbody')
    if (!tbody) return

    tbody.innerHTML = calc.total
      ? rows
          .slice(calc.start, calc.end)
          .map(function (c) {
            return pgRowHtml(c, lookups)
          })
          .join('')
      : '<tr><td colspan="8" style="text-align:center;color:#9CA3AF;padding:14px">No candidates match the current filters.</td></tr>'

    pgRenderPager(ensurePagerContainer(table), table, state, calc)
    state.dirty = false

    // Deterministic ordering: syncActionColumns() is idempotent and cheap
    // when there's nothing new to do, so calling it here — right after
    // these rows exist — guarantees every freshly rendered row gets its
    // Action cell in the same tick, rather than waiting on the
    // MutationObserver's own independently-scheduled pass to catch up.
    syncActionColumns()
  }

  function syncExplorerPagination() {
    document.querySelectorAll('table').forEach(syncTablePagination)
  }

  var pgSyncScheduled = false
  function schedulePaginationSync() {
    if (pgSyncScheduled) return
    pgSyncScheduled = true
    window.requestAnimationFrame(function () {
      pgSyncScheduled = false
      syncExplorerPagination()
    })
  }

  // Delegated once, globally: the pager's own controls are recreated on
  // every render, so binding here means they never need re-binding.
  document.addEventListener('click', function (e) {
    var btn =
      e.target && e.target.closest
        ? e.target.closest('[data-pg-nav],[data-pg-page]')
        : null
    if (!btn) return
    var pager = btn.closest('[' + PG_PAGER_ATTR + ']')
    var table = pager && pager.__pgTable
    if (!table) return
    var state = getPgState(table)
    var calc = pgCalc((window.__ROWS || []).length, state.page, state.size)
    if (btn.hasAttribute('data-pg-nav')) {
      if (btn.disabled) return
      state.page =
        btn.getAttribute('data-pg-nav') === 'prev'
          ? Math.max(1, calc.page - 1)
          : Math.min(calc.pages, calc.page + 1)
    } else {
      state.page = parseInt(btn.getAttribute('data-pg-page'), 10) || 1
    }
    state.dirty = true
    syncTablePagination(table)
  })

  document.addEventListener('change', function (e) {
    var select = e.target
    if (!select || !select.hasAttribute || !select.hasAttribute('data-pg-size'))
      return
    var pager = select.closest('[' + PG_PAGER_ATTR + ']')
    var table = pager && pager.__pgTable
    if (!table) return
    var state = getPgState(table)
    state.size =
      select.value === 'all'
        ? 'all'
        : parseInt(select.value, 10) || PG_DEFAULT_SIZE
    state.page = 1
    state.dirty = true
    syncTablePagination(table)
  })

  // ---------------------------------------------------------------------
  // Height reporting — lets the host size the iframe to the dashboard's
  // own natural content height instead of giving it a fixed viewport
  // height and letting it scroll internally. Uses ResizeObserver rather
  // than only re-measuring from the MutationObserver above, since it also
  // catches height changes that aren't caused by a DOM mutation at all —
  // e.g. the browser window narrowing and the table's own text wrapping
  // onto more lines.
  //
  // Three independent triggers feed the same scheduleReportHeight(), each
  // covering a gap the others don't:
  //  - MutationObserver (childList+subtree+attributes, set up in init()):
  //    catches re-renders (filter/sort/search rewrite #tbody) and pure
  //    visibility toggles (tab switches that only flip a class).
  //  - ResizeObserver on document.documentElement: catches layout reflows
  //    that aren't DOM mutations at all (window resize, text reflow).
  //  - A low-frequency poll (below): the guaranteed fallback for anything
  //    neither observer catches — a canvas redraw, a web component with a
  //    closed shadow root, a font finishing load, or simply a future
  //    change to the uploaded dashboard's own script that this bridge's
  //    authors never anticipated. It only ever *posts* when the measured
  //    height actually differs from what was last sent, so it costs one
  //    cheap scrollHeight read per tick and never spams the host.
  // ---------------------------------------------------------------------

  var lastReportedHeight = -1

  // scrollHeight alone can be inflated by a min-height/height:100vh/height:
  // 100% set anywhere in the ancestor chain (common in dashboard layouts
  // originally built to fill one screen) — those properties make the box
  // that tall even when it has no content down there, and scrollHeight
  // reports that empty space as if it were real. This walks the rendered
  // leaf elements (nothing with element children — a wrapper div's own box
  // can be inflated by a min-height on itself or a descendant, but a leaf
  // never is) and returns the lowest bottom edge among them, which is
  // exactly where real content ends regardless of any such CSS above it.
  function measureContentBottom() {
    if (!document.body) return 0
    var all = document.body.getElementsByTagName('*')
    var maxBottom = 0
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.children.length > 0) continue
      var tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') continue
      var rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue // display:none, detached
      if (rect.bottom > maxBottom) maxBottom = rect.bottom
    }
    return maxBottom
  }

  function measureHeight() {
    var scrollHeight = measureRawScrollHeight()
    var contentBottom = measureContentBottom()
    // Use whichever is tighter whenever the leaf-content measurement found
    // something smaller — never larger, so this can only ever correct an
    // inflated scrollHeight, never clip real content that scrollHeight
    // itself would have reported. +24px is a small safety margin for
    // trailing padding/margin below the last leaf that this measurement
    // can't otherwise see (a leaf's own box excludes an ancestor's
    // padding-bottom).
    if (contentBottom > 0 && contentBottom + 24 < scrollHeight) {
      return Math.ceil(contentBottom) + 24
    }
    return scrollHeight
  }

  function reportHeight() {
    var height = measureHeight()
    if (height === lastReportedHeight) return
    lastReportedHeight = height
    lastPolledScrollHeight = measureRawScrollHeight()
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

  // Guaranteed fallback: re-measure on a timer regardless of what triggered
  // the change, for anything neither observer catches. The full measurement
  // above (leaf-content walk across every element) is what makes this
  // correct in the presence of an inflated scrollHeight, but it's too
  // expensive to run unconditionally every 350ms for the life of the page —
  // measured at ~55ms across ~2100 elements on a 100-row table, which would
  // be a meaningful, continuous CPU cost on an otherwise idle page. Real
  // filter/sort/tab changes never rely on this poll anyway: they're DOM
  // mutations the MutationObserver already reacts to instantly, running the
  // full measurement exactly once per interaction. So the poll only needs
  // to catch changes that skip the DOM/resize path entirely (a canvas
  // redraw, a closed-shadow-root web component) — for those, gating on a
  // plain scrollHeight read (cheap: no full-tree walk) before paying for
  // the expensive measurement is safe, and keeps the idle-page cost to one
  // property read every 350ms instead of a full DOM walk.
  var lastPolledScrollHeight = -1
  function measureRawScrollHeight() {
    return Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    )
  }
  window.setInterval(function () {
    var scrollHeight = measureRawScrollHeight()
    if (scrollHeight === lastPolledScrollHeight) return
    lastPolledScrollHeight = scrollHeight
    reportHeight()
  }, 350)

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
    //
    // attributes: true (scoped to class/style) matters just as much as
    // childList here: switching tabs/sub-tabs in these dashboards is done by
    // toggling a class like `.panel.on` on already-rendered panels, not by
    // adding/removing DOM nodes — a childList-only observer never sees that,
    // so a tab hidden/shown this way (after its first, lazy-init visit)
    // never triggers a height re-report, leaving the iframe sized to
    // whatever the previous tab happened to report. Filtering/sorting itself
    // already rewrites #tbody's innerHTML (a childList change), so it was
    // already covered — this closes the gap for pure visibility toggles.
    new MutationObserver(function () {
      // Only force-close the popup if the row it belongs to was actually
      // wiped out by a re-render — not on every mutation, since appending
      // the popup itself (or the action cells) to the document is itself a
      // mutation this same observer sees.
      if (openTriggerEl && !document.body.contains(openTriggerEl)) {
        closeActionPopup()
      }
      // Pagination first: if it rebuilds #tbody (window.__ROWS changed —
      // a filter/search/sort just ran), the Action column sync right
      // after it then attaches to the freshly rendered rows in the same
      // pass instead of the stale ones.
      schedulePaginationSync()
      scheduleSyncActionColumns()
      scheduleReportHeight()
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
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
    // Explorer data is populated by the dashboard's own script during its
    // synchronous init, which has already run by the time this executes
    // (this script tag loads last, right before </body>) — so pagination
    // can activate immediately, without waiting for a DOM mutation.
    schedulePaginationSync()
    scheduleReportHeight()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
