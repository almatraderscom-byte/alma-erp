/**
 * ALMA Companion — background service worker (MV3).
 *
 * Bridges the ALMA agent (server) to THIS Chrome. It long-polls the agent's
 * live-browser command endpoint, runs each command in a grouped "ALMA" tab of
 * the owner's OWN window (his logged-in session — same cookies), draws a live
 * on-page status banner + highlight so the owner can watch every step, and
 * posts the result + a screenshot back.
 *
 * Why grouped tabs in the owner's window (v0.8.0, owner ask 2026-07-12):
 *   • Claude-in-Chrome parity: the agent works in tabs inside the CURRENT
 *     window, collected in a labeled tab group — one tab after another as the
 *     task needs, never a detached second window.
 *   • The agent still never types over the tab the owner was using — it opens
 *     its own tab(s); the owner can click away any time.
 *   • Screenshots go through chrome.debugger (CDP), which captures the agent
 *     tab even while it is in the BACKGROUND — captureVisibleTab remains only
 *     as a fallback.
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
  'pick_option',
  'upload_file',
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

// ---- ALMA tab group in the OWNER'S OWN window --------------------------------
// v0.8.0 (owner ask 2026-07-12): no separate window. The agent works in TABS
// inside the owner's current window, collected in a labeled "ALMA" tab group —
// exactly the Claude-in-Chrome shape. New tabs the task needs join the same
// group. Screenshots use the chrome.debugger CDP path so a BACKGROUND tab
// captures fine and the agent never has to steal the owner's active tab.

async function groupAgentTab(tabId) {
  try {
    // Already sitting in an ALMA group? Keep it — record that group instead of
    // moving the tab into an older stored group (cross-window moves + failed
    // moves were one source of duplicate yellow groups).
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.groupId && tab.groupId !== -1) {
        const g = await chrome.tabGroups.get(tab.groupId)
        if (g && g.title === 'ALMA') {
          await chrome.storage.local.set({ agentGroupId: g.id })
          return
        }
      }
    } catch { /* fall through to normal grouping */ }
    const { agentGroupId } = await chrome.storage.local.get('agentGroupId')
    let groupId = null
    if (agentGroupId != null) {
      try {
        await chrome.tabGroups.get(agentGroupId) // still alive?
        groupId = await chrome.tabs.group({ tabIds: tabId, groupId: agentGroupId })
      } catch {
        groupId = null // group gone — create a fresh one below
      }
    }
    if (groupId == null) {
      groupId = await chrome.tabs.group({ tabIds: tabId })
      try {
        await chrome.tabGroups.update(groupId, { title: 'ALMA', color: 'yellow' })
      } catch { /* cosmetic only */ }
    }
    await chrome.storage.local.set({ agentGroupId: groupId })
  } catch {
    /* grouping is cosmetic — the tab still works ungrouped */
  }
}

// When the stored agentTabId is stale (extension reload / Chrome restart /
// storage hiccup), ADOPT an existing "ALMA"-group tab instead of opening yet
// another tab+group — the old tab still holds the task's page state, and the
// owner ended up with 5+ stale yellow ALMA groups from repeated recreation
// (owner report 2026-07-12). Prefers a real page over about:blank, most
// recently used first. Also sweeps leftover about:blank strays from old groups.
async function adoptExistingAlmaTab() {
  try {
    const groups = await chrome.tabGroups.query({ title: 'ALMA' })
    if (!groups.length) return null
    const gids = new Set(groups.map((g) => g.id))
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id && gids.has(t.groupId))
    if (!tabs.length) return null
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    const adopted = tabs.find((t) => t.url && !t.url.startsWith('about:')) || tabs[0]
    // Sweep the other ALMA-group about:blank strays (agent-created, no content)
    // so dead groups dissolve instead of piling up in the owner's tab strip.
    for (const t of tabs) {
      if (t.id !== adopted.id && (!t.url || t.url.startsWith('about:'))) {
        try { await chrome.tabs.remove(t.id) } catch { /* already gone */ }
      }
    }
    await chrome.storage.local.set({
      agentTabId: adopted.id,
      agentWindowId: adopted.windowId,
      agentGroupId: adopted.groupId,
    })
    return adopted
  } catch {
    return null
  }
}

async function getAgentTab(createIfMissing = true) {
  const { agentTabId } = await chrome.storage.local.get('agentTabId')
  if (agentTabId) {
    try {
      const tab = await chrome.tabs.get(agentTabId)
      if (tab && tab.id) return tab
    } catch {
      /* tab was closed — fall through and adopt/recreate */
    }
  }
  // Stored id dead → reuse the existing ALMA-group tab (page state intact — the
  // task resumes with a look/refresh instead of a from-scratch walk).
  const adopted = await adoptExistingAlmaTab()
  if (adopted) return adopted
  if (!createIfMissing) return null
  // Create the work tab IN THE OWNER'S CURRENT WINDOW, active so he sees where
  // the agent works; it immediately joins (or starts) the "ALMA" tab group.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
  if (tab && tab.id) {
    await chrome.storage.local.set({ agentTabId: tab.id, agentWindowId: tab.windowId })
    await groupAgentTab(tab.id)
    return tab
  }
  return null
}

// Persist which tab/window the agent currently drives (used when following a
// popup or a newly-opened tab so subsequent commands act on the right page).
// The followed tab is pulled into the ALMA group so the whole task stays one
// visible strip of grouped tabs, Claude-style.
async function setAgentTab(tabId, windowId) {
  const patch = { agentTabId: tabId }
  if (windowId != null) patch.agentWindowId = windowId
  await chrome.storage.local.set(patch)
  await groupAgentTab(tabId)
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
  // Composition-mode exemption (mirrors COMPOSE_EXEMPT_RE in final-submit.ts):
  // "Create post" / "New ad" only OPEN an editor — the draft still needs a
  // separate Publish click, which stays blocked.
  const composeExemptRe = /\b(create|new)\s+(a\s+)?(post|ad)\b|নতুন\s*(পোস্ট|বিজ্ঞাপন)|পোস্ট\s*তৈরি/i
  const elLabel = (
    (el.innerText || el.value || '') +
    ' ' +
    (el.getAttribute('aria-label') || '') +
    ' ' +
    (el.getAttribute('title') || '')
  )
    .trim()
    .slice(0, 120)
  if (!composeExemptRe.test(elLabel) && finalSubmitRe.test(elLabel)) {
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

// ATOMIC custom-dropdown selection: open the trigger AND click the option in ONE
// page-script execution. Splitting them across two commands kept failing on
// Facebook-class UIs — the portal menu closes the instant the tab blurs or focus
// shifts between commands (2026-07-12 Ads Manager WhatsApp-number incident).
async function pagePickOption(arg) {
  const { selector, text, ref, option } = arg
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fire = (el) => {
    const r = el.getBoundingClientRect()
    const mo = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }
    try {
      el.dispatchEvent(new PointerEvent('pointerover', mo))
      el.dispatchEvent(new PointerEvent('pointerdown', mo))
    } catch { /* no PointerEvent */ }
    try {
      el.dispatchEvent(new MouseEvent('mouseover', mo))
      el.dispatchEvent(new MouseEvent('mousedown', mo))
    } catch { /* ignore */ }
    try {
      el.dispatchEvent(new PointerEvent('pointerup', mo))
    } catch { /* ignore */ }
    try {
      el.dispatchEvent(new MouseEvent('mouseup', mo))
    } catch { /* ignore */ }
    el.click()
  }
  // 1) locate the dropdown trigger (ref → selector → visible text/label)
  let trigger = null
  if (ref) {
    try {
      trigger = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]')
    } catch { trigger = null }
  }
  if (!trigger && selector) {
    try {
      trigger = document.querySelector(selector)
    } catch { trigger = null }
  }
  if (!trigger && text) {
    const needle = String(text).trim().toLowerCase()
    const hay = (e) =>
      ((e.innerText || e.value || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase()
    // The SAME text often appears on several elements (a summary chip AND the
    // real combobox — the Ads Manager WhatsApp row does exactly this). Search
    // dropdown-like roles FIRST so we never click a chip that merely toggles a
    // section; fall back to generic clickables only when no dropdown matches.
    const pools = ['[role=combobox]', '[aria-haspopup]', 'select', '[role=button],button,[tabindex]']
    const findTrigger = () => {
      for (const sel of pools) {
        const match = Array.from(document.querySelectorAll(sel))
          .filter(visible)
          .find((e) => hay(e).includes(needle))
        if (match) return match
      }
      return null
    }
    trigger = findTrigger()
    // SELF-HEALING: Ads-Manager-style sections start COLLAPSED — the text shows
    // on a summary chip but the real combobox isn't rendered yet. If no dropdown-
    // role trigger exists, click the chip once to expand the section, then re-scan.
    if (!trigger || !/combobox|select/i.test(trigger.getAttribute('role') || trigger.tagName)) {
      const chip = Array.from(document.querySelectorAll('[role=button],[tabindex],button,div'))
        .filter(visible)
        .filter((e) => e.childElementCount <= 6 && hay(e).includes(needle))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
      if (chip && (!trigger || chip !== trigger)) {
        fire(chip)
        for (let i = 0; i < 8; i++) {
          await sleep(300)
          const t = findTrigger()
          if (t && /combobox|select/i.test(t.getAttribute('role') || t.tagName)) {
            trigger = t
            break
          }
        }
        if (!trigger) trigger = findTrigger()
      }
    }
  }
  if (!trigger) return { ok: false, error: 'dropdown trigger not found' }
  const want = String(option == null ? '' : option).trim()
  if (!want) return { ok: false, error: 'pick_option needs `option` (visible option text)' }
  // Fast-fail on non-dropdowns: after self-healing, if the best match still has
  // no dropdown semantics, firing it opens panels/popups instead of a menu and
  // the option search burns seconds before a confusing miss (2026-07-12 "Use
  // existing posts" mode-switch). Tell the model the right tool immediately.
  const trigRole = (trigger.getAttribute('role') || '') + ' ' + trigger.tagName
  const trigHaspopup = trigger.getAttribute('aria-haspopup')
  const byTextOnly = Boolean(text && !selector && !ref)
  if (byTextOnly && !/combobox|select|listbox/i.test(trigRole) && !(trigHaspopup && trigHaspopup !== 'false')) {
    return {
      ok: false,
      error:
        'not_a_dropdown: "' + String(text || selector || ref || '').slice(0, 50) +
        '" কোনো dropdown নয় — pick_option নয়, action:"click" দিয়ে সরাসরি ক্লিক করো (দরকারে option-টার নিজের টেক্সটে click করো)।',
    }
  }
  // Native <select> → set value directly (React-safe).
  if (trigger.tagName === 'SELECT') return pageSelect({ selector, text, ref, option })
  trigger.scrollIntoView({ block: 'center' })
  await sleep(200)
  fire(trigger)
  // 2) wait for the portal menu to render, then click the matching option —
  //    all within this single injected script, so nothing can blur in between.
  const lowWant = want.toLowerCase()
  const digits = want.replace(/\D/g, '')
  const findOption = () => {
    const opts = Array.from(
      document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],li,[role=listbox] *'),
    ).filter(visible)
    return (
      opts.find((e) => (e.innerText || '').trim().toLowerCase() === lowWant) ||
      opts.find((e) => (e.innerText || '').toLowerCase().includes(lowWant)) ||
      // phone numbers etc: match on digits so formatting differences don't matter
      (digits.length >= 6
        ? opts.find((e) => (e.innerText || '').replace(/\D/g, '').includes(digits))
        : null) ||
      null
    )
  }
  let target = null
  for (let i = 0; i < 12 && !target; i++) {
    await sleep(250)
    target = findOption()
  }
  if (!target) {
    // leave the menu as we found it (Escape) and report what WAS visible
    const seen = Array.from(document.querySelectorAll('[role=option],[role=menuitem]'))
      .filter(visible)
      .slice(0, 12)
      .map((e) => (e.innerText || '').trim().slice(0, 60))
    return { ok: false, error: 'option not found: ' + want, optionsSeen: seen }
  }
  target.scrollIntoView({ block: 'center' })
  await sleep(150)
  fire(target)
  await sleep(400)
  return { ok: true, picked: (target.innerText || '').trim().slice(0, 80) }
}

// Put a real File into a page's <input type="file"> — the DataTransfer trick.
// The service worker fetches the bytes (page CSP can't); this injected half
// rebuilds the File and fires the change events frameworks listen for. This is
// what lets the agent attach its own generated images (e.g. carousel creatives)
// instead of stopping to ask the owner to drag files in.
async function pageUploadFile(arg) {
  const { selector, text, ref, b64, filename, mime } = arg
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 || r.height > 0 || e.type === 'file' // file inputs are often hidden
  }
  let input = null
  if (ref) {
    try { input = document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]') } catch { input = null }
  }
  if (!input && selector) {
    try { input = document.querySelector(selector) } catch { input = null }
  }
  if (input && input.type !== 'file') input = input.querySelector ? input.querySelector('input[type=file]') : null
  if (!input && text) {
    const needle = String(text).toLowerCase()
    input = Array.from(document.querySelectorAll('input[type=file]')).find((e) => {
      const label = (
        (e.getAttribute('aria-label') || '') + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' +
        ((e.labels && e.labels[0] && e.labels[0].innerText) || '') + ' ' +
        ((e.closest('label') && e.closest('label').innerText) || '')
      ).toLowerCase()
      return label.includes(needle)
    }) || null
  }
  if (!input) {
    // Most upload UIs have exactly ONE (hidden) file input behind the pretty button.
    const all = Array.from(document.querySelectorAll('input[type=file]'))
    input = all.length === 1 ? all[0] : all.filter(visible)[0] || all[0] || null
  }
  if (!input) return { ok: false, error: 'file input not found — আগে upload বাটনে click করে file-picker UI টা আনো, তারপর আবার চেষ্টা করো' }
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const file = new File([bytes], filename || 'upload.jpg', { type: mime || 'application/octet-stream' })
  const dt = new DataTransfer()
  // multiple-select inputs keep already-attached files so the agent can add 10 images one by one
  if (input.multiple && input.files && input.files.length) {
    for (const f of Array.from(input.files)) dt.items.add(f)
  }
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, attached: file.name, totalFiles: input.files.length, multiple: Boolean(input.multiple) }
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

// Hard timeout for any promise. chrome.scripting.executeScript NEVER resolves if
// the page navigates away mid-script (the injected context is destroyed) — that
// hung executeCommand forever, which hung the ENTIRE poll loop: every following
// command timed out server-side as companion_offline_or_busy until the service
// worker restarted (2026-07-12 pick_option incident). Everything long-running is
// now raced against a deadline so one bad step can never jam the companion.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'step_timeout: ' + label + ' (' + ms + 'ms) — পেজ সম্ভবত navigate/re-render করেছে; আবার চেষ্টা করো' }), ms),
    ),
  ])
}

async function runInPage(tabId, func, arg) {
  const run = chrome.scripting
    .executeScript({ target: { tabId }, func, args: arg ? [arg] : [] })
    .then(([res]) => (res ? res.result : null))
  return withTimeout(run, 15000, 'page script')
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
function tabReachedNavigation(tab, expectedUrl, previousUrl) {
  const actual = String((tab && (tab.pendingUrl || tab.url)) || '')
  if (!expectedUrl) return actual && !actual.startsWith('about:')
  try {
    const wanted = new URL(expectedUrl)
    const current = new URL(actual)
    const wantedHost = wanted.hostname.replace(/^www\./, '')
    const currentHost = current.hostname.replace(/^www\./, '')
    // Normal http→https / www redirects stay on the same host. Cross-host auth
    // redirects are also valid once the tab has actually left the previous URL.
    return currentHost === wantedHost || (actual !== previousUrl && /^https?:/i.test(actual))
  } catch {
    return actual !== previousUrl && /^https?:/i.test(actual)
  }
}

async function waitForTabLoad(tabId, timeoutMs, expectedUrl, previousUrl) {
  const deadline = Date.now() + timeoutMs
  await new Promise((r) => setTimeout(r, 350)) // let the navigation actually begin
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t && t.status === 'complete' && tabReachedNavigation(t, expectedUrl, previousUrl)) {
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

const WRITE_VERBS = new Set(['click', 'type', 'press', 'select_option', 'pick_option', 'upload_file'])

// ---- CDP screenshots (chrome.debugger) ---------------------------------------
// captureVisibleTab only shoots the ACTIVE tab of a window; now that the agent
// works in a grouped tab of the owner's own window, the tab is often in the
// background. The debugger path captures the agent tab regardless of focus —
// the same mechanism Claude-in-Chrome uses (Chrome shows its standard
// "…is debugging this browser" bar while attached; it clears on detach).

async function ensureDebugger(tabId) {
  const { cdpTabId } = await chrome.storage.local.get('cdpTabId')
  if (cdpTabId != null && cdpTabId !== tabId) {
    try {
      await chrome.debugger.detach({ tabId: cdpTabId })
    } catch { /* old tab gone */ }
    await chrome.storage.local.remove('cdpTabId')
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    await chrome.storage.local.set({ cdpTabId: tabId })
    return true
  } catch (err) {
    if (/already attached/i.test(String(err && err.message))) {
      await chrome.storage.local.set({ cdpTabId: tabId })
      return true
    }
    return false
  }
}

async function captureAgentTab(tab) {
  // 1) CDP — works even when the agent tab is in the background.
  if (await ensureDebugger(tab.id)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const shot = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 80,
        })
        if (shot && shot.data) return 'data:image/jpeg;base64,' + shot.data
        break
      } catch {
        // Stale attachment (worker restarted, Chrome dropped it) → re-attach once.
        await chrome.storage.local.remove('cdpTabId')
        if (!(await ensureDebugger(tab.id))) break
      }
    }
  }
  // 2) Fallback — visible-tab capture; only right when the agent tab is active
  //    (e.g. the owner revoked the debugger permission or DevTools is attached).
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 })
  } catch {
    return null
  }
}

chrome.debugger?.onDetach?.addListener(async (source) => {
  const { cdpTabId } = await chrome.storage.local.get('cdpTabId')
  if (source && source.tabId === cdpTabId) await chrome.storage.local.remove('cdpTabId')
})

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

  // Write verbs need the agent tab FOCUSED: since v0.8.0 it lives in the owner's
  // own window, and sites like Facebook close open dropdowns/menus the moment the
  // tab blurs — a click sequence spanning two commands (open dropdown → click
  // option) kept failing with element-not-found because the list vanished
  // between rounds. Fronting the tab for interactions mirrors a human session.
  if (WRITE_VERBS.has(action)) {
    try {
      if (!tab.active) await chrome.tabs.update(tab.id, { active: true })
    } catch { /* tab gone — the command itself will surface the error */ }
  }

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
    const previousUrl = tab.url || ''
    await chrome.tabs.update(tab.id, { url: cmd.url })
    // Front the ALMA tab (inside the owner's own window) so he SEES each page as
    // it loads — Claude-in-Chrome behaviour. Screenshots don't need this (CDP
    // captures background tabs); it's purely the "watch live" moment.
    try {
      await chrome.tabs.update(tab.id, { active: true })
    } catch {
      /* tab gone — next getAgentTab recreates */
    }
    await waitForTabLoad(tab.id, 15000, cmd.url, previousUrl)
    const landed = await chrome.tabs.get(tab.id).catch(() => null)
    if (!landed || !tabReachedNavigation(landed, cmd.url, previousUrl)) {
      return {
        ok: false,
        error: `navigation_not_committed: tab stayed at ${String(landed && landed.url || previousUrl || 'unknown')}`,
      }
    }
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
    const dataUrl = await captureAgentTab(tab)
    if (!dataUrl) return { ok: false, error: 'could not capture screenshot' }
    return { ok: true, screenshot: dataUrl }
  }
  if (action === 'read_text') {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!current || !/^https?:\/\//i.test(current.url || '')) {
      return { ok: false, error: `tab_not_readable: ${String(current && current.url || 'missing')}` }
    }
    await showOverlay(tab.id, 'পেজ পড়ছে…')
    return { ok: true, data: await runInPage(tab.id, pageReadText) }
  }
  if (action === 'read_dom') {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!current || !/^https?:\/\//i.test(current.url || '')) {
      return { ok: false, error: `tab_not_readable: ${String(current && current.url || 'missing')}` }
    }
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
  if (action === 'pick_option') {
    await showOverlay(tab.id, 'ড্রপডাউন থেকে বাছছে: ' + String(cmd.option || '').slice(0, 40))
    // Atomic open+choose — one injected script, so the menu can't blur-close
    // between the trigger click and the option click.
    return await actWithRetry(tab.id, pagePickOption, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      option: cmd.option,
    })
  }
  if (action === 'upload_file') {
    const src = String(cmd.url || '')
    if (!/^https:\/\//i.test(src) || /^(https:\/\/)(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(src)) {
      return { ok: false, error: 'upload_file needs a public https url' }
    }
    await showOverlay(tab.id, 'ফাইল বসাচ্ছে: ' + (cmd.filename || src.split('/').pop() || '').slice(0, 40))
    let resp
    try {
      resp = await withTimeout(fetch(src), 20000, 'file download')
      if (resp && resp.ok === false && resp.error) return resp // withTimeout shape
    } catch (err) {
      return { ok: false, error: 'file download failed: ' + (err && err.message ? err.message : String(err)) }
    }
    if (!resp.ok) return { ok: false, error: 'file download failed: HTTP ' + resp.status }
    const mime = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0]
    if (!/^(image|video)\/|^application\/pdf$/.test(mime)) {
      return { ok: false, error: 'unsupported file type: ' + mime + ' (image/video/pdf only)' }
    }
    const buf = await resp.arrayBuffer()
    if (buf.byteLength > 15 * 1024 * 1024) return { ok: false, error: 'file too large (>15MB)' }
    // ArrayBuffer → base64 (executeScript args must be JSON-serializable)
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    const b64 = btoa(bin)
    const fname = cmd.filename || decodeURIComponent((src.split('/').pop() || 'upload').split('?')[0]) || 'upload'
    return await actWithRetry(tab.id, pageUploadFile, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      b64,
      filename: fname,
      mime,
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
    } catch {
      return { ok: false, error: 'could not switch tab' }
    }
    // setAgentTab also pulls the followed tab into the ALMA tab group.
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
  if (!token || paused) return 'stop'
  let cmd = null
  try {
    const res = await fetch(`${baseUrl}${POLL_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      await chrome.storage.local.set({ token: '', lastError: 'pairing rejected (401)' })
      return 'stop'
    }
    if (!res.ok) {
      await chrome.storage.local.set({ lastError: `server heartbeat failed (${res.status})` })
      return 'retry'
    }
    await chrome.storage.local.set({ lastSuccessfulPollAt: Date.now(), lastError: '' })
    const body = await res.json().catch(() => ({}))
    cmd = body && body.command ? body.command : null
  } catch (err) {
    await chrome.storage.local.set({
      lastError: `server heartbeat failed: ${err && err.message ? err.message : String(err)}`,
    })
    return 'retry'
  }
  if (!cmd) return 'connected' // connected, just idle
  await setBadge('run')
  let result
  try {
    // Whole-command ceiling: even if some await inside executeCommand wedges
    // (destroyed page context, stuck dialog), the loop must move on and report —
    // one bad step must never take the companion "offline" for everything after.
    result = await withTimeout(executeCommand(cmd), 35000, cmd.action || 'command')
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) }
  }
  await postResult(baseUrl, token, cmd.id, result)
  await setBadge('on')
  return 'connected'
}

async function loop() {
  if (looping) return
  looping = true
  try {
    // Keep cycling while paired + active. Each pollOnce returns quickly; the
    // server long-polls so this stays gentle.
    for (let i = 0; i < 1000; i++) {
      const state = await pollOnce()
      if (state === 'stop') break
      // A transient network/server failure must not silently kill the bridge
      // until the next browser alarm. Retry with a gentle backoff instead.
      await new Promise((r) => setTimeout(r, state === 'retry' ? 5000 : 800))
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
  // Forget any tab/group/debugger state from a previous load so the next task
  // starts a fresh grouped tab (a reload also drops CDP attachments).
  await chrome.storage.local.remove(['agentTabId', 'agentWindowId', 'agentGroupId', 'cdpTabId'])
  loop()
})
chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.paused) loop()
})

// If the owner closes the ALMA tab, forget it (and its debugger attachment) so
// the next command opens a fresh grouped tab.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { agentTabId, cdpTabId } = await chrome.storage.local.get(['agentTabId', 'cdpTabId'])
  if (agentTabId === tabId) await chrome.storage.local.remove(['agentTabId', 'agentWindowId'])
  if (cdpTabId === tabId) await chrome.storage.local.remove('cdpTabId')
})

// Popup ↔ background messaging (pairing / status / kill switch).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ;(async () => {
    if (msg.type === 'status') {
      const c = await getConfig()
      const health = await chrome.storage.local.get(['lastSuccessfulPollAt', 'lastError'])
      sendResponse({
        paired: Boolean(c.token),
        paused: c.paused,
        baseUrl: c.baseUrl,
        deviceName: c.deviceName,
        lastSuccessfulPollAt: Number(health.lastSuccessfulPollAt || 0),
        lastError: String(health.lastError || ''),
      })
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
    await chrome.storage.local.set({
      token: body.token,
      baseUrl: base,
      paused: false,
      deviceName: deviceName || 'My Chrome',
      lastSuccessfulPollAt: Date.now(),
      lastError: '',
    })
    await setBadge('on')
    loop()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}
