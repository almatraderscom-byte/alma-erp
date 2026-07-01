/**
 * ALMA Companion — background service worker (MV3).
 *
 * Bridges the ALMA agent (server) to THIS Chrome. It long-polls the agent's
 * live-browser command endpoint, runs each command in the owner's active tab
 * (his own logged-in session), and posts the result + a screenshot back.
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
  'scroll',
  'wait',
  'screenshot',
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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab || null
}

// ---- injected page functions (run in the page, not here) -------------------

function pageReadText() {
  const t = document.body ? document.body.innerText : ''
  return { url: location.href, title: document.title, text: t.slice(0, 12000) }
}

function pageReadDom() {
  const out = []
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]'
  const els = Array.from(document.querySelectorAll(sel)).slice(0, 200)
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || el.getAttribute('aria-label') || null,
      text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
      id: el.id || null,
    })
  }
  return { url: location.href, title: document.title, elements: out }
}

function pageClick(arg) {
  const { selector, text } = arg
  let el = null
  if (selector) el = document.querySelector(selector)
  if (!el && text) {
    const all = Array.from(document.querySelectorAll('a,button,[role=button],input,[role=link]'))
    el = all.find((e) => (e.innerText || e.value || '').trim().toLowerCase().includes(String(text).toLowerCase())) || null
  }
  if (!el) return { ok: false, error: 'element not found' }
  el.scrollIntoView({ block: 'center' })
  el.click()
  return { ok: true }
}

function pageType(arg) {
  const { selector, text, value } = arg
  let el = selector ? document.querySelector(selector) : null
  if (!el && text) {
    const all = Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]'))
    el = all.find((e) => (e.getAttribute('aria-label') || e.placeholder || e.name || '').toLowerCase().includes(String(text).toLowerCase())) || null
  }
  if (!el) return { ok: false, error: 'field not found' }
  el.focus()
  if (el.isContentEditable) {
    el.textContent = value
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

function pageScroll(arg) {
  const by = Number(arg && arg.by) || 600
  window.scrollBy({ top: by, behavior: 'smooth' })
  return { ok: true, scrolledBy: by }
}

// ---- command execution ------------------------------------------------------

async function runInPage(tabId, func, arg) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: arg ? [arg] : [] })
  return res ? res.result : null
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

  const tab = await activeTab()
  if (!tab || !tab.id) return { ok: false, error: 'no active tab' }

  if (action === 'navigate') {
    if (!/^https?:\/\//i.test(cmd.url || '')) return { ok: false, error: 'navigate needs http(s) url' }
    await chrome.tabs.update(tab.id, { url: cmd.url })
    await new Promise((r) => setTimeout(r, 2500))
    return { ok: true, data: { url: cmd.url } }
  }
  if (action === 'screenshot') {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
    return { ok: true, screenshot: dataUrl }
  }
  if (action === 'read_text') return { ok: true, data: await runInPage(tab.id, pageReadText) }
  if (action === 'read_dom') return { ok: true, data: await runInPage(tab.id, pageReadDom) }
  if (action === 'scroll') return await runInPage(tab.id, pageScroll, { by: cmd.by })
  if (action === 'click') return await runInPage(tab.id, pageClick, { selector: cmd.selector, text: cmd.text })
  if (action === 'type') return await runInPage(tab.id, pageType, { selector: cmd.selector, text: cmd.text, value: cmd.value })
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
chrome.runtime.onInstalled.addListener(() => loop())
chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.paused) loop()
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
