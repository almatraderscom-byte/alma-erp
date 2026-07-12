/**
 * ALMA Companion — background service worker (MV3).
 *
 * Bridges the ALMA agent (server) to THIS Chrome. It long-polls the agent's
 * live-browser command endpoint, runs each command in a DEDICATED ALMA window
 * (the owner's own logged-in session — same cookies), draws a live on-page
 * status banner + highlight so the owner can watch every step, and posts the
 * result + a screenshot back.
 *
 * Why a dedicated window (v0.2.0):
 *   • The agent NEVER hijacks the tab the owner is working in. It opens/keeps
 *     one separate ALMA window and drives that, so the owner can keep browsing
 *     (and keep chatting with the agent) in his other windows/tabs.
 *   • Screenshots use captureVisibleTab on that window, which works even when
 *     it's not focused — so the owner watches without being interrupted.
 *
 * Safety model:
 *   • Paired to ONE owner via a one-time code → a bearer `token` (kept in
 *     chrome.storage.local, never leaves this browser except as Authorization).
 *   • A local kill switch (`paused`) the owner controls from the popup; while
 *     paused, NOTHING runs no matter what the server sends.
 *   • The extension is deliberately "dumb + obedient": it executes only the
 *     whitelisted command verbs below. All approval / money / irreversible
 *     gating is enforced server-side before a command is ever handed out.
 */

const POLL_PATH = '/api/assistant/live-browser/poll'
const RESULT_PATH = '/api/assistant/live-browser/result'
const DEFAULT_BASE = 'https://alma-erp-six.vercel.app'

const ALLOWED_ACTIONS = new Set([
  'ping',
  'navigate',
  'read_text',
  'read_dom',
  'click',
  'type',
  'press',
  'select_option',
  'hover',
  'scroll',
  'scroll_to',
  'wait',
  'screenshot',
  'go_back',
  'switch_tab',
  'close_tab',
])

let looping = false

async function getConfig() {
  const c = await chrome.storage.local.get(['baseUrl', 'token', 'paused', 'deviceName'])
  return {
    baseUrl: (c.baseUrl || DEFAULT_BASE).replace(/\/$/, ''),
    token: c.token || '',
    paused: Boolean(c.paused),
    deviceName: c.deviceName || 'My Chrome',
  }
}

// ---- dedicated ALMA work window --------------------------------------------
// All page actions run here, never in the owner's active tab.

async function getAgentTab(createIfMissing = true) {
  const { agentTabId } = await chrome.storage.local.get('agentTabId')
  if (agentTabId) {
    try {
      const tab = await chrome.tabs.get(agentTabId)
      if (tab && tab.id) return tab
    } catch {
      /* tab was closed — fall through and recreate */
    }
  }
  if (!createIfMissing) return null
  // First creation is focused=true so the owner SEES the ALMA window appear and
  // knows where to watch; later navigations won't steal focus again.
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: true,
    width: 1200,
    height: 860,
  })
  const tab = win && win.tabs && win.tabs[0]
  if (tab && tab.id) {
    await chrome.storage.local.set({ agentTabId: tab.id, agentWindowId: win.id })
    return tab
  }
  return null
}

// Persist which tab/window the agent currently drives (used when following a
// popup or a newly-opened tab so subsequent commands act on the right page).
async function setAgentTab(tabId, windowId) {
  const patch = { agentTabId: tabId }
  if (windowId != null) patch.agentWindowId = windowId
  await chrome.storage.local.set(patch)
}

// Find the tab the agent should follow to — a link/button often opens a new tab
// or popup window. We pick the NEWEST http(s) tab that isn't the current agent
// tab (Chrome assigns monotonically increasing tab ids, so the largest id is the
// most recently opened). Returns null when there's nothing new to follow.
async function pickFollowTab(currentTab) {
  let tabs
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return null
  }
  const curId = currentTab && currentTab.id
  let best = null
  for (const t of tabs) {
    if (!t || !t.id || t.id === curId) continue
    if (!/^https?:\/\//i.test(t.url || '')) continue
    if (!best || t.id > best.id) best = t
  }
  return best
}

// ---- injected page functions (run in the page, not here) -------------------

function pageReadText() {
  const t = document.body ? document.body.innerText : ''
  return { url: location.href, title: document.title, text: t.slice(0, 12000) }
}

function pageReadDom() {
  const out = []
  // Heavy SPAs (Facebook Ads Manager / Business Suite) build everything from divs:
  // options, radios, switches and grid cells are ARIA roles, and many clickables are
  // bare [tabindex] divs. Cover those too, and read the elements IN THE VIEWPORT
  // first — on a huge page the old first-250-in-DOM-order sample was mostly nav
  // chrome while the actual target (a dropdown option, a table row) never made the
  // list. That was the root cause of the 2026-07-12 Ads Manager failure.
  const sel =
    'a,button,input,textarea,select,[role=button],[role=link],[role=combobox],[role=menuitem],' +
    '[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=checkbox],[role=radio],' +
    '[role=option],[role=switch],[role=treeitem],[role=gridcell],[contenteditable=true],[tabindex]'
  const all = []
  const seen = new Set()
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (seen.has(el)) continue
    seen.add(el)
    if (el.getAttribute && el.getAttribute('tabindex') === '-1' && !el.getAttribute('role')) continue
    all.push(el)
  }
  const vh = window.innerHeight
  const vw = window.innerWidth
  const inViewport = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
  const visible = []
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    visible.push({ el, vp: inViewport(r) })
  }
  // In-viewport elements first, DOM order preserved within each group.
  visible.sort((a, b) => (a.vp === b.vp ? 0 : a.vp ? -1 : 1))
  const els = visible.slice(0, 300)
  let n = 0
  for (const { el, vp } of els) {
    // Stamp a STABLE ref onto the real DOM node. It survives across executeScript
    // injections (same page), so click/type/select can target `ref` for a precise
    // hit on crowded pages instead of re-matching fuzzy text.
    const ref = 'e' + ++n
    try {
      el.setAttribute('data-alma-ref', ref)
    } catch {
      /* frozen node — ignore */
    }
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : null),
      role: el.getAttribute('role') || null,
      name: el.getAttribute('name') || el.getAttribute('aria-label') || null,
      text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
      // For a <select>, surface its options so the model can pick one by exact text.
      options:
        el.tagName === 'SELECT'
          ? Array.from(el.options)
              .slice(0, 30)
              .map((o) => (o.text || '').trim())
          : undefined,
      id: el.id || null,
      // vp=false → below/above the fold; scroll_to its ref before clicking.
      vp,
    })
  }
  return { url: location.href, title: document.title, elements: out }
}

// Live status banner + moving cursor dot — injected so the owner SEES the agent
// working end-to-end, Claude-extension style. Self-contained, pointer-events off.
function pageOverlay(arg) {
  const label = (arg && arg.label) || ''
  const box = { x: arg && arg.x, y: arg && arg.y }
  const root = document.documentElement
  let bar = document.getElementById('__alma_bar__')
  if (!bar) {
    const st = document.createElement('style')
    st.textContent =
      '@keyframes __almapulse{0%,100%{opacity:1}50%{opacity:.3}}' +
      '#__alma_bar__{position:fixed;z-index:2147483647;left:50%;top:14px;transform:translateX(-50%);' +
      'background:rgba(18,18,26,.94);color:#f4e9c9;font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
      'padding:9px 16px;border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.4);' +
      'border:1px solid rgba(201,168,76,.55);display:flex;align-items:center;gap:9px;pointer-events:none}' +
      '#__alma_dot__{width:9px;height:9px;border-radius:50%;background:#c9a84c;box-shadow:0 0 9px #c9a84c;animation:__almapulse 1s infinite}' +
      // Bold, ALWAYS-visible cursor (owner feedback): solid gold core + white ring,
      // strong glow — reads clearly on light AND dark pages.
      '#__alma_cur__{position:fixed;z-index:2147483647;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;' +
      'border:3px solid #fff;background:radial-gradient(circle,#e8c964 0%,#c9a84c 60%,rgba(201,168,76,.5) 100%);' +
      'box-shadow:0 0 0 2px rgba(139,92,246,.8),0 0 18px 4px rgba(201,168,76,.9),0 2px 8px rgba(0,0,0,.45);' +
      'pointer-events:none;transition:left .55s cubic-bezier(.25,.8,.35,1),top .55s cubic-bezier(.25,.8,.35,1)}' +
      '#__alma_stop__{pointer-events:auto;cursor:pointer;background:#e05252;color:#fff;border:none;border-radius:999px;' +
      'font:700 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:6px 12px;margin-left:4px;box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
      '#__alma_stop__:hover{background:#c73e3e}' +
      // Agent-control aura — the owner's requested "Claude feel": a soft glowing
      // frame around the whole page the entire time the agent is driving.
      '@keyframes __almaaura{0%,100%{box-shadow:inset 0 0 34px 6px rgba(139,92,246,.38),inset 0 0 90px 14px rgba(201,168,76,.14)}' +
      '50%{box-shadow:inset 0 0 46px 10px rgba(139,92,246,.55),inset 0 0 110px 18px rgba(201,168,76,.22)}}' +
      '#__alma_aura__{position:fixed;inset:0;z-index:2147483646;pointer-events:none;' +
      'border:2px solid rgba(139,92,246,.6);animation:__almaaura 2.2s ease-in-out infinite}' +
      // Click ripple at the exact click point
      '@keyframes __almaripple{0%{transform:scale(.3);opacity:.9}100%{transform:scale(2.6);opacity:0}}' +
      '.__alma_ripple__{position:fixed;z-index:2147483647;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;' +
      'border:3px solid #c9a84c;background:rgba(201,168,76,.18);pointer-events:none;animation:__almaripple .55s ease-out forwards}'
    root.appendChild(st)
    bar = document.createElement('div')
    bar.id = '__alma_bar__'
    bar.innerHTML =
      '<span id="__alma_dot__"></span><span id="__alma_txt__"></span>' +
      '<button id="__alma_stop__" type="button">STOP ⏹</button>'
    root.appendChild(bar)
    // Owner's always-visible kill switch, right on the page. Runs in the
    // isolated world → content-script chrome.storage access; the background
    // loop reads `paused` before every command, so this stops the NEXT step
    // immediately and the popup shows "থামানো আছে".
    const stopBtn = document.getElementById('__alma_stop__')
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        try {
          chrome.storage.local.set({ paused: true })
        } catch { /* storage unavailable — popup pause still works */ }
        const t = document.getElementById('__alma_txt__')
        if (t) t.textContent = 'থামানো হয়েছে — popup থেকে আবার চালু করা যাবে'
        document.getElementById('__alma_aura__')?.remove()
        document.getElementById('__alma_cur__')?.remove()
        stopBtn.remove()
      })
    }
  }
  // Aura on whenever the agent is driving this page (created once, stays until
  // the page unloads or the owner pauses from the popup).
  if (!document.getElementById('__alma_aura__')) {
    const aura = document.createElement('div')
    aura.id = '__alma_aura__'
    root.appendChild(aura)
  }
  // Cursor is ALWAYS present while the agent drives (owner feedback) — parked
  // near the top-center until an action moves it to a real target.
  if (!document.getElementById('__alma_cur__')) {
    const cur = document.createElement('div')
    cur.id = '__alma_cur__'
    cur.style.left = Math.round(window.innerWidth / 2) + 'px'
    cur.style.top = '96px'
    root.appendChild(cur)
  }
  const txt = document.getElementById('__alma_txt__')
  if (txt) txt.textContent = 'ALMA কাজ করছে · ' + label
  // Idle watchdog (owner feedback 2026-07-11): when the agent finishes, fails or
  // gets stuck, the page must return to NORMAL by itself. Every overlay update
  // refreshes the stamp; one page-side interval fades everything out after 25s
  // with no new command. The next command recreates the overlay from scratch.
  window.__almaOverlayStamp = Date.now()
  if (!window.__almaOverlayWatchdog) {
    window.__almaOverlayWatchdog = setInterval(() => {
      if (Date.now() - (window.__almaOverlayStamp || 0) < 25000) return
      clearInterval(window.__almaOverlayWatchdog)
      window.__almaOverlayWatchdog = null
      for (const id of ['__alma_bar__', '__alma_aura__', '__alma_cur__']) {
        const el = document.getElementById(id)
        if (!el) continue
        el.style.transition = 'opacity .8s ease'
        el.style.opacity = '0'
        setTimeout(() => el.remove(), 900)
      }
    }, 5000)
  }
  if (typeof box.x === 'number' && typeof box.y === 'number') {
    let cur = document.getElementById('__alma_cur__')
    if (!cur) {
      cur = document.createElement('div')
      cur.id = '__alma_cur__'
      root.appendChild(cur)
    }
    cur.style.left = box.x + 'px'
    cur.style.top = box.y + 'px'
  }
  return { ok: true }
}

async function pageClick(arg) {
  const { selector, text, ref } = arg
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  let el = null
  if (ref) {
    try {
      el = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch {
      el = null
    }
  }
  if (!el && selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
  }
  if (!el && text) {
    const needle = String(text).trim().toLowerCase()
    // Facebook-class SPAs render "buttons" as divs with ARIA roles (option/radio/
    // checkbox/switch/gridcell) or bare [tabindex] — the old anchor/button-only list
    // returned "element not found" on exactly those (Ads Manager incident 2026-07-12).
    const cand = Array.from(
      document.querySelectorAll(
        'a,button,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],' +
          '[role=tab],[role=option],[role=radio],[role=checkbox],[role=switch],[role=combobox],' +
          '[role=treeitem],[role=gridcell],input[type=submit],input[type=button],input[type=radio],' +
          'input[type=checkbox],label,summary,[onclick],[tabindex]',
      ),
    ).filter(visible)
    const hay = (e) =>
      (
        (e.innerText || e.value || '') +
        ' ' +
        (e.getAttribute('aria-label') || '') +
        ' ' +
        (e.getAttribute('title') || '')
      )
        .trim()
        .toLowerCase()
    // Prefer an exact match, then a substring match — steadier than "first contains".
    // Among substring matches prefer the SHORTEST haystack (the tightest element),
    // not the first in DOM order — big wrapper divs often contain the text too.
    el = cand.find((e) => hay(e) === needle) || null
    if (!el) {
      const subs = cand.filter((e) => {
        const h = hay(e)
        return h && h.includes(needle) && h.length <= needle.length + 220
      })
      subs.sort((a, b) => hay(a).length - hay(b).length)
      el = subs[0] || null
    }
    // Last resort: find the deepest visible node containing the text, then climb to
    // the nearest clickable ancestor. Catches text inside spans whose clickable
    // wrapper carries no matching label/aria of its own.
    if (!el) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let leaf = null
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent || !node.textContent.toLowerCase().includes(needle)) continue
        const p = node.parentElement
        if (!p || !visible(p)) continue
        leaf = p
        break
      }
      if (leaf) {
        el =
          leaf.closest(
            'a,button,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=tab],' +
              '[role=option],[role=radio],[role=checkbox],[role=switch],[role=combobox],label,[onclick],[tabindex]',
          ) || leaf
      }
    }
  }
  if (!el) return { ok: false, error: 'element not found' }
  // FINAL-SUBMIT BAN (enforced in code — mirrors src/agent/lib/browser/final-submit.ts;
  // keep the two regexes in sync). The agent may fill forms and navigate, but the last
  // irreversible Send/Post/Pay/Publish/Confirm/Delete click is the OWNER's. This checks
  // the RESOLVED element's real label, so ref/selector targeting can't slip past it.
  const finalSubmitRe = new RegExp(
    [
      '\\b(send|post|publish|pay|buy|purchase|confirm|delete|transfer|submit|checkout)\\b',
      '\\bplace\\s+order\\b',
      '\\border\\s+now\\b',
      'পাঠান',
      'পাঠিয়ে\\s*দিন',
      'পোস্ট\\s*করুন',
      'পাবলিশ',
      'প্রকাশ\\s*করুন',
      'কিনুন',
      'অর্ডার\\s*করুন',
      'নিশ্চিত\\s*করুন',
      'কনফার্ম',
      'ডিলিট',
      'মুছে\\s*ফেলুন',
      'সাবমিট',
      'পেমেন্ট\\s*করুন',
    ].join('|'),
    'i',
  )
  const elLabel = (
    (el.innerText || el.value || '') +
    ' ' +
    (el.getAttribute('aria-label') || '') +
    ' ' +
    (el.getAttribute('title') || '')
  )
    .trim()
    .slice(0, 120)
  if (finalSubmitRe.test(elLabel)) {
    return {
      ok: false,
      blocked: true,
      error:
        'final_submit_blocked: "' +
        elLabel.slice(0, 60) +
        '" — এই শেষ অপরিবর্তনীয় বাটনটা owner নিজ হাতে চাপবেন (কোড-লেভেল নিরাপত্তা)।',
    }
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await sleep(350)
  const rect = el.getBoundingClientRect()
  const prevOutline = el.style.outline
  el.style.outline = '3px solid #c9a84c'
  el.style.outlineOffset = '2px'
  // point the ALMA cursor at the target so the owner sees WHAT gets clicked
  const cx = Math.round(rect.left + rect.width / 2)
  const cy = Math.round(rect.top + rect.height / 2)
  let cur = document.getElementById('__alma_cur__')
  if (cur) {
    cur.style.left = cx + 'px'
    cur.style.top = cy + 'px'
  }
  await sleep(450)
  // Click ripple at the exact point — the owner SEES the click land.
  try {
    const rip = document.createElement('div')
    rip.className = '__alma_ripple__'
    rip.style.left = cx + 'px'
    rip.style.top = cy + 'px'
    document.documentElement.appendChild(rip)
    setTimeout(() => rip.remove(), 650)
  } catch { /* visual only */ }
  // Fire a real pointer+mouse event sequence — many sites (React/SPA, and Facebook
  // in particular) listen on POINTER events and ignore a bare .click(). Then call
  // .click() as backstop.
  const mo = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }
  try {
    el.dispatchEvent(new PointerEvent('pointerover', mo))
    el.dispatchEvent(new PointerEvent('pointerdown', mo))
  } catch {
    /* engines without PointerEvent — mouse sequence below still fires */
  }
  try {
    el.dispatchEvent(new MouseEvent('mouseover', mo))
    el.dispatchEvent(new MouseEvent('mousedown', mo))
  } catch {
    /* older engines — ignore */
  }
  try {
    el.dispatchEvent(new PointerEvent('pointerup', mo))
  } catch {
    /* ignore */
  }
  try {
    el.dispatchEvent(new MouseEvent('mouseup', mo))
  } catch {
    /* ignore */
  }
  el.click()
  setTimeout(() => {
    el.style.outline = prevOutline
  }, 600)
  return { ok: true, clicked: (el.innerText || el.value || '').trim().slice(0, 60) }
}

async function pageType(arg) {
  const { selector, text, value, submit, ref } = arg
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // Set a value the way React/Vue/Angular controlled inputs actually accept it:
  // go through the element PROTOTYPE's native value setter, then fire a real
  // InputEvent. A bare `el.value = x` is silently reverted by React on next
  // render (the exact reason the ALMA composer needed form_input).
  const almaSetValue = (el, val) => {
    if (el.isContentEditable) {
      el.focus()
      try {
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, val)
      } catch {
        /* execCommand unsupported — fall through */
      }
      if ((el.innerText || el.textContent || '').trim() === '' && val) {
        el.textContent = val
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }))
      }
      return
    }
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, val)
    else el.value = val
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const almaDispatchKey = (el, key) => {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    const kd = new KeyboardEvent('keydown', opts)
    el.dispatchEvent(kd)
    el.dispatchEvent(new KeyboardEvent('keypress', opts))
    el.dispatchEvent(new KeyboardEvent('keyup', opts))
    return kd
  }
  let el = null
  if (ref) {
    try {
      el = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch {
      el = null
    }
  }
  if (!el && selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
  }
  if (!el && text) {
    const needle = String(text).toLowerCase()
    el =
      Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]'))
        .filter(visible)
        .find((e) =>
          (
            (e.getAttribute('aria-label') || '') +
            ' ' +
            (e.placeholder || '') +
            ' ' +
            (e.name || '') +
            ' ' +
            (e.getAttribute('title') || '')
          )
            .toLowerCase()
            .includes(needle),
        ) || null
  }
  // Fallbacks so we rarely get stuck: the already-focused editable, else the first
  // visible text field on the page.
  if (!el) {
    const a = document.activeElement
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) el = a
  }
  if (!el) {
    el =
      Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable=true]'))
        .filter(visible)[0] || null
  }
  if (!el) return { ok: false, error: 'field not found' }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus()
  const prevOutline = el.style.outline
  el.style.outline = '3px solid #c9a84c'
  el.style.outlineOffset = '2px'
  await sleep(300)
  // Human-paced typing: grow the value in a few chunks so the owner watches the
  // text being "typed" — each chunk still goes through the framework-safe setter
  // (React/Vue keep the final value), so this is purely visual pacing.
  const fullText = value == null ? '' : String(value)
  if (fullText.length > 3 && fullText.length <= 200) {
    const chunks = Math.min(6, Math.max(3, Math.ceil(fullText.length / 18)))
    for (let ci = 1; ci < chunks; ci++) {
      almaSetValue(el, fullText.slice(0, Math.ceil((fullText.length * ci) / chunks)))
      await sleep(90 + Math.random() * 120)
    }
  }
  almaSetValue(el, fullText)
  if (submit) {
    await sleep(150)
    // Synthetic Enter first — many SPA search boxes listen for keydown even though
    // isTrusted is false. But sites like Google IGNORE untrusted keys, so if Enter
    // wasn't swallowed we submit the enclosing FORM directly. requestSubmit() fires
    // the submit event (so React/SPA handlers run + client routing works); if that's
    // unavailable or throws we force a native form.submit() (hard GET navigation —
    // exactly what a Google search needs). Clicking Google's btnK is deliberately
    // avoided: it's flaky because the autocomplete dropdown intercepts the click.
    const kd = almaDispatchKey(el, 'Enter')
    if (!kd.defaultPrevented) {
      const form = el.closest && el.closest('form')
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          try {
            form.requestSubmit()
          } catch {
            try {
              form.submit()
            } catch {
              /* ignore */
            }
          }
        } else {
          try {
            form.submit()
          } catch {
            /* ignore */
          }
        }
      } else {
        // No enclosing form — click the nearest submit/search button as a fallback.
        const btn = document.querySelector(
          'button[type=submit],input[type=submit],[aria-label*="search" i][role=button],button[aria-label*="search" i]',
        )
        if (btn) btn.click()
      }
    }
  }
  setTimeout(() => {
    el.style.outline = prevOutline
  }, 600)
  return { ok: true, typed: value == null ? '' : String(value), submitted: Boolean(submit) }
}

function pageKey(arg) {
  const key = String((arg && arg.key) || 'Enter')
  const map = {
    Enter: { keyCode: 13, code: 'Enter', k: 'Enter' },
    Tab: { keyCode: 9, code: 'Tab', k: 'Tab' },
    Escape: { keyCode: 27, code: 'Escape', k: 'Escape' },
    Esc: { keyCode: 27, code: 'Escape', k: 'Escape' },
    ArrowDown: { keyCode: 40, code: 'ArrowDown', k: 'ArrowDown' },
    ArrowUp: { keyCode: 38, code: 'ArrowUp', k: 'ArrowUp' },
    ArrowLeft: { keyCode: 37, code: 'ArrowLeft', k: 'ArrowLeft' },
    ArrowRight: { keyCode: 39, code: 'ArrowRight', k: 'ArrowRight' },
    Backspace: { keyCode: 8, code: 'Backspace', k: 'Backspace' },
    Delete: { keyCode: 46, code: 'Delete', k: 'Delete' },
    Space: { keyCode: 32, code: 'Space', k: ' ' },
  }
  const info = map[key] || { keyCode: 0, code: key, k: key }
  const opts = {
    key: info.k,
    code: info.code,
    keyCode: info.keyCode,
    which: info.keyCode,
    bubbles: true,
    cancelable: true,
  }
  const el =
    document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body
  const kd = new KeyboardEvent('keydown', opts)
  el.dispatchEvent(kd)
  el.dispatchEvent(new KeyboardEvent('keypress', opts))
  el.dispatchEvent(new KeyboardEvent('keyup', opts))
  if (key === 'Enter' && !kd.defaultPrevented) {
    // Sites like Google ignore untrusted synthetic Enter, so submit the FORM directly.
    let form = el.closest && el.closest('form')
    if (!form) {
      // `press` is a separate command from `type`; focus may have moved off the field.
      // Recover by finding the first visible text field that lives inside a form.
      const cand = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea')).find((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && e.closest('form')
      })
      form = cand && cand.closest('form')
    }
    if (form) {
      // requestSubmit() runs the submit event (SPA handlers + client routing); if that
      // is unavailable or throws, force a native submit (hard navigation). Never rely on
      // clicking a specific submit button — that path is flaky on Google.
      if (typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit()
        } catch {
          try {
            form.submit()
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          form.submit()
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ok: true, pressed: key }
}

// Pick a value in a native <select>. Custom (ARIA) dropdowns are NOT <select> —
// for those the model should click the trigger then click the option instead.
function pageSelect(arg) {
  const { selector, text, ref, option, value } = arg
  const want = String((option != null ? option : value) == null ? '' : option != null ? option : value)
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  let el = null
  if (ref) {
    try {
      el = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch {
      el = null
    }
  }
  if (!el && selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
  }
  if (!el && text) {
    const needle = String(text).toLowerCase()
    el =
      Array.from(document.querySelectorAll('select'))
        .filter(visible)
        .find((s) =>
          (
            (s.getAttribute('aria-label') || '') +
            ' ' +
            (s.name || '') +
            ' ' +
            (s.getAttribute('title') || '')
          )
            .toLowerCase()
            .includes(needle),
        ) || null
  }
  if (!el) el = Array.from(document.querySelectorAll('select')).filter(visible)[0] || null
  if (!el) return { ok: false, error: 'select not found' }
  if (el.tagName !== 'SELECT') {
    return { ok: false, error: 'target is not a native <select> — click the dropdown, then click the option' }
  }
  const opts = Array.from(el.options)
  const low = want.trim().toLowerCase()
  const opt =
    opts.find((o) => (o.text || '').trim().toLowerCase() === low) ||
    opts.find((o) => String(o.value).toLowerCase() === low) ||
    (low ? opts.find((o) => (o.text || '').trim().toLowerCase().includes(low)) : null)
  if (!opt) {
    return { ok: false, error: 'option not found: ' + want, options: opts.slice(0, 20).map((o) => (o.text || '').trim()) }
  }
  el.focus()
  // React-safe: go through the prototype value setter, then fire input + change.
  const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
  if (desc && desc.set) desc.set.call(el, opt.value)
  else el.value = opt.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selected: (opt.text || '').trim(), value: opt.value }
}

// Bring a specific element into view (center) so the next click/read is precise
// on a long page. Targets by ref → selector → visible text.
function pageScrollTo(arg) {
  const { selector, text, ref } = arg
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  }
  let el = null
  if (ref) {
    try {
      el = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch {
      el = null
    }
  }
  if (!el && selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
  }
  if (!el && text) {
    const needle = String(text).toLowerCase()
    el =
      Array.from(
        document.querySelectorAll(
          'a,button,h1,h2,h3,h4,li,td,th,span,p,label,[role=button],[role=link],[role=option],' +
            '[role=radio],[role=checkbox],[role=menuitem],[role=tab],[role=gridcell],[tabindex]',
        ),
      )
        .filter(visible)
        .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) ||
      null
  }
  if (!el) return { ok: false, error: 'element not found to scroll to' }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  return { ok: true, scrolledTo: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60) }
}

function pageScroll(arg) {
  const by = Number(arg && arg.by) || 600
  window.scrollBy({ top: by, behavior: 'smooth' })
  return { ok: true, scrolledBy: by }
}

// Move the mouse over an element (by ref → selector → visible text) to reveal
// hover-only menus / tooltips before clicking them. Dispatches the full pointer +
// mouse enter/over sequence so hover-driven UIs (dropdown menus, submenus) open.
function pageHover(arg) {
  const { selector, text, ref } = arg
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  let el = null
  if (ref) {
    try {
      el = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch {
      el = null
    }
  }
  if (!el && selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
  }
  if (!el && text) {
    const needle = String(text).toLowerCase()
    el =
      Array.from(
        document.querySelectorAll(
          'a,button,li,span,div,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],' +
            '[role=gridcell],[role=combobox],[tabindex]',
        ),
      )
        .filter(visible)
        .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) ||
      null
  }
  if (!el) return { ok: false, error: 'element not found to hover' }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
    try {
      el.dispatchEvent(new MouseEvent(type, opts))
    } catch {
      /* some engines lack pointer events — ignore */
    }
  }
  return { ok: true, hovered: (el.innerText || el.getAttribute('aria-label') || el.tagName || '').trim().slice(0, 60) }
}

// ---- command execution ------------------------------------------------------

async function runInPage(tabId, func, arg) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: arg ? [arg] : [] })
  return res ? res.result : null
}

// Run the same page function in EVERY frame of the tab (main doc + all iframes).
// Chrome injects into each frame separately; we return the first frame whose
// result is `ok`, otherwise the first defined result. Used as an automatic
// fallback when the main-document lookup misses — the target element may live
// inside an embedded iframe (checkout widgets, embedded forms, etc.).
async function runInAllFrames(tabId, func, arg) {
  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args: arg ? [arg] : [],
    })
  } catch {
    return null
  }
  if (!Array.isArray(results)) return null
  let firstDefined = null
  for (const r of results) {
    const val = r ? r.result : null
    if (val && val.ok) return val
    if (val && firstDefined === null) firstDefined = val
  }
  return firstDefined
}

// Run a page function that targets an element, but tolerate the element not being
// rendered YET: retry a few times with a short wait, then fall back to searching
// all iframes. This is the main "never get stuck on a not-yet-loaded element"
// guard — async apps (React/SPA) often render the target a beat after the click
// that triggered it. Returns the first ok result, else the last non-ok result.
async function actWithRetry(tabId, func, arg) {
  let last = await runInPage(tabId, func, arg)
  if (last && last.ok) return last
  for (let i = 0; i < 3 && !(last && last.ok); i++) {
    await new Promise((r) => setTimeout(r, 450))
    last = await runInPage(tabId, func, arg)
  }
  if (last && last.ok) return last
  const alt = await runInAllFrames(tabId, func, arg)
  if (alt && alt.ok) return alt
  return last || alt
}

// Wait until the tab finishes loading (status === 'complete') instead of a blind
// fixed sleep — fast pages proceed immediately, slow ones get up to timeoutMs.
async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  await new Promise((r) => setTimeout(r, 350)) // let the navigation actually begin
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t && t.status === 'complete') {
        // Heavy SPAs (Facebook etc.) fire 'complete' on the skeleton — give client
        // rendering a real beat so reads/screenshots see actual content.
        await new Promise((r) => setTimeout(r, 1500))
        return
      }
    } catch {
      return // tab gone — nothing to wait for
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// Best-effort: paint the status banner in the ALMA tab. Never throws (about:blank
// / chrome:// pages can't be scripted, and that's fine).
async function showOverlay(tabId, label) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageOverlay, args: [{ label }] })
  } catch {
    /* page not scriptable yet — ignore */
  }
}

// Site trust lockdown (§5.4): the server ships the current lockdown-domain list
// with every WRITE command; we check the ACTIVE tab's REAL hostname here (the
// server can't see redirects/tab follows). Suffix match: "example.com" also
// covers "shop.example.com". Returns the matched domain, or null when clear.
function lockdownMatch(url, domains) {
  if (!Array.isArray(domains) || domains.length === 0) return null
  let host = ''
  try {
    host = new URL(url || '').hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (!host) return null
  for (const d of domains) {
    const dom = String(d || '').toLowerCase()
    if (!dom) continue
    if (host === dom || host.endsWith('.' + dom)) return dom
  }
  return null
}

const WRITE_VERBS = new Set(['click', 'type', 'press', 'select_option'])

async function executeCommand(cmd) {
  const action = String(cmd.action || '')
  if (!ALLOWED_ACTIONS.has(action)) return { ok: false, error: `unsupported action: ${action}` }
  if (action === 'ping') return { ok: true, data: { pong: true } }
  if (action === 'wait') {
    const ms = Math.min(Math.max(Number(cmd.ms) || 1000, 0), 30000)
    await new Promise((r) => setTimeout(r, ms))
    return { ok: true }
  }

  const tab = await getAgentTab(true)
  if (!tab || !tab.id) return { ok: false, error: 'could not open ALMA window' }

  // READ-ONLY lockdown: refuse writes on a lockdown-tier site. Reading, scrolling,
  // screenshots and navigation stay allowed — lockdown means extraction-only.
  if (WRITE_VERBS.has(action)) {
    const locked = lockdownMatch(tab.url, cmd.lockdownDomains)
    if (locked) {
      await showOverlay(tab.id, 'সাইটটা lockdown — শুধু পড়া যাবে')
      return {
        ok: false,
        blocked: true,
        error:
          'site_lockdown: ' +
          locked +
          ' — এই সাইটটা read-only (lockdown) তালিকায়; এখানে ক্লিক/টাইপ কোড-লেভেলে বন্ধ। ' +
          'Boss চাইলে trust tier বদলে খুলে দিতে পারেন।',
      }
    }
  }

  if (action === 'navigate') {
    if (!/^https?:\/\//i.test(cmd.url || '')) return { ok: false, error: 'navigate needs http(s) url' }
    await chrome.tabs.update(tab.id, { url: cmd.url })
    // Bring the ALMA window to the front so the owner SEES each page as it loads.
    // (This is the "watch live" moment; between tasks he can click back to his
    // own window, or hit Pause in the popup to stop entirely.)
    try {
      await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true })
    } catch {
      /* window gone — ignore, next getAgentTab recreates */
    }
    await waitForTabLoad(tab.id, 15000)
    await showOverlay(tab.id, 'পেজ খুলছে: ' + cmd.url.replace(/^https?:\/\//, '').slice(0, 48))
    return { ok: true, data: { url: cmd.url } }
  }
  if (action === 'go_back') {
    try {
      await chrome.tabs.goBack(tab.id)
    } catch {
      return { ok: false, error: 'no page to go back to' }
    }
    await waitForTabLoad(tab.id, 12000)
    await showOverlay(tab.id, 'পিছনে যাচ্ছে…')
    return { ok: true, data: { back: true } }
  }
  if (action === 'screenshot') {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 })
    return { ok: true, screenshot: dataUrl }
  }
  if (action === 'read_text') {
    await showOverlay(tab.id, 'পেজ পড়ছে…')
    return { ok: true, data: await runInPage(tab.id, pageReadText) }
  }
  if (action === 'read_dom') {
    await showOverlay(tab.id, 'পেজ দেখছে…')
    return { ok: true, data: await runInPage(tab.id, pageReadDom) }
  }
  if (action === 'scroll') {
    await showOverlay(tab.id, 'স্ক্রল করছে…')
    return await runInPage(tab.id, pageScroll, { by: cmd.by })
  }
  if (action === 'click') {
    await showOverlay(tab.id, 'ক্লিক করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    // actWithRetry: tolerate an element that renders a beat late + search iframes.
    return await actWithRetry(tab.id, pageClick, { selector: cmd.selector, text: cmd.text, ref: cmd.ref })
  }
  if (action === 'type') {
    await showOverlay(tab.id, 'লিখছে: ' + String(cmd.value || '').slice(0, 40))
    const r = await actWithRetry(tab.id, pageType, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      value: cmd.value,
      submit: Boolean(cmd.submit),
    })
    if (r && r.ok && cmd.submit) await waitForTabLoad(tab.id, 12000)
    return r
  }
  if (action === 'select_option') {
    await showOverlay(tab.id, 'অপশন বাছছে: ' + String(cmd.option || cmd.value || '').slice(0, 40))
    return await actWithRetry(tab.id, pageSelect, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      option: cmd.option,
      value: cmd.value,
    })
  }
  if (action === 'hover') {
    await showOverlay(tab.id, 'হোভার করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    return await actWithRetry(tab.id, pageHover, { selector: cmd.selector, text: cmd.text, ref: cmd.ref })
  }
  if (action === 'scroll_to') {
    await showOverlay(tab.id, 'স্ক্রল করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    return await actWithRetry(tab.id, pageScrollTo, { selector: cmd.selector, text: cmd.text, ref: cmd.ref })
  }
  if (action === 'switch_tab') {
    const picked = await pickFollowTab(tab)
    if (!picked) return { ok: false, error: 'no other tab to switch to' }
    try {
      await chrome.tabs.update(picked.id, { active: true })
      await chrome.windows.update(picked.windowId, { focused: true, drawAttention: true })
    } catch {
      return { ok: false, error: 'could not switch tab' }
    }
    await setAgentTab(picked.id, picked.windowId)
    await waitForTabLoad(picked.id, 12000)
    await showOverlay(picked.id, 'নতুন ট্যাবে গেছে')
    return { ok: true, data: { url: picked.url || '', title: picked.title || '' } }
  }
  if (action === 'close_tab') {
    // Close the newest extra tab (e.g. a popup) and fall back to the agent tab.
    const extra = await pickFollowTab(tab)
    if (!extra) return { ok: false, error: 'no extra tab to close' }
    try {
      await chrome.tabs.remove(extra.id)
    } catch {
      return { ok: false, error: 'could not close tab' }
    }
    await setAgentTab(tab.id, tab.windowId)
    try {
      await chrome.tabs.update(tab.id, { active: true })
    } catch {
      /* ignore */
    }
    return { ok: true, data: { closed: extra.url || extra.id } }
  }
  if (action === 'press') {
    await showOverlay(tab.id, 'কী চাপছে: ' + String(cmd.key || 'Enter').slice(0, 20))
    const r = await runInPage(tab.id, pageKey, { key: cmd.key })
    // Enter often triggers navigation/submit — give the page a moment to settle.
    if (r && r.ok && String(cmd.key || 'Enter') === 'Enter') await waitForTabLoad(tab.id, 12000)
    return r
  }
  return { ok: false, error: 'unhandled action' }
}

// ---- poll loop --------------------------------------------------------------

async function postResult(base, token, commandId, result) {
  try {
    await fetch(`${base}${RESULT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ commandId, ...result }),
    })
  } catch (err) {
    console.warn('[alma-companion] postResult failed:', err && err.message)
  }
}

async function pollOnce() {
  const { baseUrl, token, paused } = await getConfig()
  if (!token || paused) return false
  let cmd = null
  try {
    const res = await fetch(`${baseUrl}${POLL_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      await chrome.storage.local.set({ token: '', lastError: 'pairing rejected (401)' })
      return false
    }
    if (!res.ok) return false
    const body = await res.json().catch(() => ({}))
    cmd = body && body.command ? body.command : null
  } catch {
    return false
  }
  if (!cmd) return true // connected, just idle
  await setBadge('run')
  let result
  try {
    result = await executeCommand(cmd)
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) }
  }
  await postResult(baseUrl, token, cmd.id, result)
  await setBadge('on')
  return true
}

async function loop() {
  if (looping) return
  looping = true
  try {
    // Keep cycling while paired + active. Each pollOnce returns quickly; the
    // server long-polls so this stays gentle.
    for (let i = 0; i < 1000; i++) {
      const cont = await pollOnce()
      if (!cont) break
      await new Promise((r) => setTimeout(r, 800))
    }
  } finally {
    looping = false
  }
}

async function setBadge(state) {
  const map = { on: { t: '●', c: '#2e7d32' }, run: { t: '…', c: '#c9a84c' }, off: { t: '', c: '#888' } }
  const s = map[state] || map.off
  try {
    await chrome.action.setBadgeText({ text: s.t })
    await chrome.action.setBadgeBackgroundColor({ color: s.c })
  } catch {
    /* noop */
  }
}

// ── Self-update (multi-Mac) ─────────────────────────────────────────────────
// Production republishes the extension on every main merge
// (<site>/companion-version.json + /companion/…); a tiny per-machine updater
// (companion-updater.sh via launchd) syncs those files into this unpacked
// folder. Here: (a) the moment the DISK copy is newer than the running one,
// reload ourselves — the update applies with zero clicks; (b) if production
// has a newer version the updater hasn't fetched yet, tell the owner once.
function versionNewer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

async function checkForUpdate() {
  const running = chrome.runtime.getManifest().version
  try {
    // Unpacked extensions serve files from disk — a bumped manifest on disk
    // means the updater already delivered a new build. Apply it now.
    const disk = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then((r) => r.json())
    if (disk?.version && disk.version !== running) {
      chrome.runtime.reload()
      return
    }
  } catch { /* disk read failed — fall through to the remote check */ }
  try {
    const { baseUrl } = await getConfig()
    const res = await fetch(`${baseUrl || DEFAULT_BASE}/companion-version.json`, { cache: 'no-store' })
    if (!res.ok) return
    const remote = (await res.json())?.version
    if (!remote || !versionNewer(remote, running)) return
    const { updNotifiedFor } = await chrome.storage.local.get('updNotifiedFor')
    if (updNotifiedFor === remote) return
    await chrome.storage.local.set({ updNotifiedFor: remote })
    chrome.notifications?.create('alma-companion-update', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ALMA Companion আপডেট আছে',
      message: `নতুন ভার্সন v${remote} তৈরি (এখন v${running})। updater চালু থাকলে ৩০ মিনিটের মধ্যে নিজে থেকেই বসে যাবে।`,
    })
  } catch { /* offline — try again next alarm */ }
}

// Re-arm the loop periodically (MV3 workers sleep when idle).
chrome.alarms.create('alma-poll', { periodInMinutes: 1 })
chrome.alarms.create('alma-update-check', { periodInMinutes: 10 })
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'alma-update-check') {
    checkForUpdate()
    return
  }
  if (a.name !== 'alma-poll') return
  const { token, paused } = await getConfig()
  await setBadge(token && !paused ? 'on' : 'off')
  if (token && !paused) loop()
})

chrome.runtime.onStartup.addListener(() => loop())
chrome.runtime.onInstalled.addListener(async () => {
  // Forget any window from a previous load so the next task opens a fresh,
  // visible ALMA window (avoids reusing one buried behind other windows).
  await chrome.storage.local.remove(['agentTabId', 'agentWindowId'])
  loop()
})
chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.paused) loop()
})

// If the owner closes the ALMA window, forget it so the next command opens a fresh one.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { agentTabId } = await chrome.storage.local.get('agentTabId')
  if (agentTabId === tabId) await chrome.storage.local.remove(['agentTabId', 'agentWindowId'])
})

// Popup ↔ background messaging (pairing / status / kill switch).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ;(async () => {
    if (msg.type === 'status') {
      const c = await getConfig()
      sendResponse({ paired: Boolean(c.token), paused: c.paused, baseUrl: c.baseUrl, deviceName: c.deviceName })
    } else if (msg.type === 'pair') {
      const r = await pairWithCode(msg.code, msg.baseUrl, msg.deviceName)
      sendResponse(r)
    } else if (msg.type === 'setPaused') {
      await chrome.storage.local.set({ paused: Boolean(msg.paused) })
      await setBadge(msg.paused ? 'off' : 'on')
      sendResponse({ ok: true })
    } else if (msg.type === 'unpair') {
      await chrome.storage.local.set({ token: '' })
      await setBadge('off')
      sendResponse({ ok: true })
    }
  })()
  return true // async response
})

async function pairWithCode(code, baseUrlIn, deviceName) {
  const base = (baseUrlIn || DEFAULT_BASE).replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/assistant/live-browser/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim(), deviceName: deviceName || 'My Chrome' }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) return { ok: false, error: body.error || `pairing failed (${res.status})` }
    await chrome.storage.local.set({ token: body.token, baseUrl: base, paused: false, deviceName: deviceName || 'My Chrome' })
    await setBadge('on')
    loop()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}
