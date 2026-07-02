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
  const sel =
    'a,button,input,textarea,select,[role=button],[role=link],[role=combobox],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[contenteditable=true]'
  const els = Array.from(document.querySelectorAll(sel)).slice(0, 250)
  let n = 0
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
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
      '#__alma_cur__{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'border:2px solid #c9a84c;background:rgba(201,168,76,.25);box-shadow:0 0 12px rgba(201,168,76,.7);' +
      'pointer-events:none;transition:left .35s ease,top .35s ease}'
    root.appendChild(st)
    bar = document.createElement('div')
    bar.id = '__alma_bar__'
    bar.innerHTML = '<span id="__alma_dot__"></span><span id="__alma_txt__"></span>'
    root.appendChild(bar)
  }
  const txt = document.getElementById('__alma_txt__')
  if (txt) txt.textContent = 'ALMA কাজ করছে · ' + label
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
    const cand = Array.from(
      document.querySelectorAll(
        'a,button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit],input[type=button],label,summary,[onclick]',
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
    el = cand.find((e) => hay(e) === needle) || cand.find((e) => hay(e).includes(needle)) || null
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
  // Fire a real mouse-event sequence — many sites (React/SPA) ignore a bare
  // .click() but respond to pointer/mouse events. Then call .click() as backstop.
  const mo = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }
  try {
    el.dispatchEvent(new MouseEvent('mouseover', mo))
    el.dispatchEvent(new MouseEvent('mousedown', mo))
    el.dispatchEvent(new MouseEvent('mouseup', mo))
  } catch {
    /* older engines — ignore */
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
  almaSetValue(el, value == null ? '' : String(value))
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
      Array.from(document.querySelectorAll('a,button,h1,h2,h3,h4,li,td,th,span,p,label,[role=button],[role=link]'))
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
      Array.from(document.querySelectorAll('a,button,li,span,div,[role=button],[role=link],[role=menuitem]'))
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
        await new Promise((r) => setTimeout(r, 500)) // small settle for late scripts
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
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
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

// Re-arm the loop periodically (MV3 workers sleep when idle).
chrome.alarms.create('alma-poll', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(async (a) => {
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
