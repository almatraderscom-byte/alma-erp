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

import {
  createKeyedSerialOperationQueue,
  createSerialOperationQueue,
  fetchPreviewWithDeadline,
  previewAttemptMayMutate,
  PreviewDeadlineError,
  recoverTimedOutOperation,
  resetPreviewCaptureState,
  runPreviewCaptureExclusive,
  withPreviewDeadline,
} from './preview-liveness.js'

const POLL_PATH = '/api/assistant/live-browser/poll'
const AUTHORIZE_PATH = '/api/assistant/live-browser/authorize'
const UNPAIR_PATH = '/api/assistant/live-browser/unpair'
// Poll capability handshake. The server must not deliver commands to older
// Companions that execute immediately without the final /authorize fence.
const COMPANION_PROTOCOL = 'authorize-v1'
const RESULT_PATH = '/api/assistant/live-browser/result'
const FRAME_PATH = '/api/assistant/live-browser/frames'
const DEFAULT_BASE = 'https://alma-erp-six.vercel.app'
const PREVIEW_CAPTURE_CALL_TIMEOUT_MS = 3_000
const PREVIEW_UPLOAD_TIMEOUT_MS = 5_000
const PREVIEW_TAB_LOOKUP_TIMEOUT_MS = 3_000
const PREVIEW_ACK_TIMEOUT_MS = 2_000
const COMMAND_CAPTURE_CALL_TIMEOUT_MS = 8_000
const CDP_RECOVERY_TIMEOUT_MS = 3_000
const CDP_DRAIN_TIMEOUT_MS = 3_000
const DEBUGGER_ATTACH_TIMEOUT_MS = 5_000
const VISIBLE_TAB_LOOKUP_TIMEOUT_MS = 3_000
const COMMAND_AUTHORIZATION_TIMEOUT_MS = 5_000
const COMMAND_EXECUTION_TIMEOUT_MS = 35_000
const PAGE_SCRIPT_TIMEOUT_MS = 15_000
// Execute-once outbox: a mutating command may already have changed the page
// when its result POST loses the network response. Keep that exact result
// across MV3 worker sleeps/reloads and do not ask for another command until the
// server has acknowledged (or no longer knows) this one.
const PENDING_RESULT_KEY = 'pendingCommandResult'

const ALLOWED_ACTIONS = new Set([
  'ping',
  'get_identity',
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
let previewGrant = null
let previewTimer = null
const previewCaptureState = { busy: false, generation: 0, activeGeneration: null }
const cdpOperationQueue = createSerialOperationQueue()
const debuggerRecoveryQueue = createKeyedSerialOperationQueue(performDebuggerRecovery)
let debuggerPoisoned = false
let lastPreviewCaptureMs = 0
// An unpacked-extension updater may replace manifest.json at any time. Never
// reload between a page effect and the durable result receipt that proves it;
// otherwise a reclaimed click/type command could execute twice.
let commandInFlight = false
let reloadPending = false

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

async function groupAgentTab(tabId, isCurrent = () => true) {
  try {
    // Already sitting in an ALMA group? Keep it — record that group instead of
    // moving the tab into an older stored group (cross-window moves + failed
    // moves were one source of duplicate yellow groups).
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!isCurrent()) return
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
        if (!isCurrent()) return
        groupId = await chrome.tabs.group({ tabIds: tabId, groupId: agentGroupId })
      } catch {
        groupId = null // group gone — create a fresh one below
      }
    }
    if (groupId == null) {
      if (!isCurrent()) return
      groupId = await chrome.tabs.group({ tabIds: tabId })
      try {
        if (!isCurrent()) return
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
async function adoptExistingAlmaTab(isCurrent = () => true) {
  try {
    const groups = await chrome.tabGroups.query({ title: 'ALMA' })
    if (!isCurrent()) return null
    if (!groups.length) return null
    const gids = new Set(groups.map((g) => g.id))
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id && gids.has(t.groupId))
    if (!isCurrent()) return null
    if (!tabs.length) return null
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    const adopted = tabs.find((t) => t.url && !t.url.startsWith('about:')) || tabs[0]
    // Sweep the other ALMA-group about:blank strays (agent-created, no content)
    // so dead groups dissolve instead of piling up in the owner's tab strip.
    for (const t of tabs) {
      if (t.id !== adopted.id && (!t.url || t.url.startsWith('about:'))) {
        if (!isCurrent()) return null
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

async function getAgentTab(createIfMissing = true, isCurrent = () => true) {
  const { agentTabId } = await chrome.storage.local.get('agentTabId')
  if (!isCurrent()) return null
  if (agentTabId) {
    try {
      const tab = await chrome.tabs.get(agentTabId)
      if (!isCurrent()) return null
      if (tab && tab.id) return tab
    } catch {
      /* tab was closed — fall through and adopt/recreate */
    }
  }
  // Stored id dead → reuse the existing ALMA-group tab (page state intact — the
  // task resumes with a look/refresh instead of a from-scratch walk).
  const adopted = await adoptExistingAlmaTab(isCurrent)
  if (adopted) return adopted
  if (!createIfMissing) return null
  // Create the work tab IN THE OWNER'S CURRENT WINDOW, active so he sees where
  // the agent works; it immediately joins (or starts) the "ALMA" tab group.
  if (!isCurrent()) return null
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
  if (tab && tab.id) {
    await chrome.storage.local.set({ agentTabId: tab.id, agentWindowId: tab.windowId })
    if (!isCurrent()) return null
    await groupAgentTab(tab.id, isCurrent)
    return tab
  }
  return null
}

// Persist which tab/window the agent currently drives (used when following a
// popup or a newly-opened tab so subsequent commands act on the right page).
// The followed tab is pulled into the ALMA group so the whole task stays one
// visible strip of grouped tabs, Claude-style.
async function setAgentTab(tabId, windowId, isCurrent = () => true) {
  if (!isCurrent()) return false
  const patch = { agentTabId: tabId }
  if (windowId != null) patch.agentWindowId = windowId
  await chrome.storage.local.set(patch)
  if (!isCurrent()) return false
  await groupAgentTab(tabId, isCurrent)
  return isCurrent()
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

function pageReadText(arg) {
  const expectedCurrentUrl = String(arg && arg.expectedCurrentUrl || '')
  const expectedDocumentId = String(arg && arg.expectedDocumentId || '')
  let currentUrl = ''
  let currentDocumentId = ''
  try {
    currentUrl = String(location.href)
    currentDocumentId = String(Math.round(performance.timeOrigin))
  } catch { /* blocked below */ }
  const exactObservationRequired = Boolean(arg && (
    Object.prototype.hasOwnProperty.call(arg, 'expectedCurrentUrl')
    || Object.prototype.hasOwnProperty.call(arg, 'expectedDocumentId')
  ))
  // Direct reads are authorized for one exact renderer document. Do this in
  // the same injected task that samples the page so an outer tab check cannot
  // race a SPA/manual navigation and expose the replacement document.
  if (
    exactObservationRequired
    && (
      !expectedCurrentUrl
      || !expectedDocumentId
      || currentUrl !== expectedCurrentUrl
      || currentDocumentId !== expectedDocumentId
    )
  ) {
    return { __almaObservationBlocked: true }
  }
  const requiredHost = String(arg && arg.requiredHost || '').trim().toLowerCase().replace(/^www\./, '')
  if (requiredHost) {
    let host = ''
    try { host = location.hostname.toLowerCase().replace(/^www\./, '') } catch { /* blocked below */ }
    // `requiredHost` is an audited exact consumer surface, not an eTLD+1
    // suffix. In particular, youtube.com must never authorize private surfaces
    // such as studio.youtube.com or music.youtube.com.
    if (host !== requiredHost) {
      return { __almaHostBlocked: true }
    }
  }
  // Scroll blindness fix (owner report 2026-07-16): the old read returned the
  // first 12k chars with NO hint that more existed below — the model believed
  // it saw the whole page. Now every read carries scroll metrics + an explicit
  // truncated flag, and `from` lets the server window through long documents.
  const t = document.body ? document.body.innerText : ''
  const from = Math.max(0, Number(arg && arg.from) || 0)
  const doc = document.documentElement
  // Playback proof for media tasks. A screenshot can show a video frame while
  // the player is paused, so expose the live HTMLMediaElement state alongside
  // the ordinary page text. Keep this metadata content-free: title/query proof
  // still comes from the page URL/title/text, while this only proves motion.
  const mediaNodes = Array.from(document.querySelectorAll('video,audio')).slice(0, 6)
  const youtubeIdentityFromUrl = (value) => {
    try {
      const url = new URL(String(value || ''), location.href)
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (url.protocol !== 'https:' || host !== 'youtube.com') return null
      if (url.pathname === '/watch') {
        const videoId = String(url.searchParams.get('v') || '').trim()
        return /^[A-Za-z0-9_-]{11}$/.test(videoId)
          ? { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` }
          : null
      }
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)\/?$/)
      if (!shortsMatch || !shortsMatch[1]) return null
      const videoId = decodeURIComponent(shortsMatch[1]).trim()
      return /^[A-Za-z0-9_-]{11}$/.test(videoId)
        ? { videoId, canonicalUrl: `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}` }
        : null
    } catch { return null }
  }
  const elementValue = (node, attribute) => {
    if (!node) return ''
    const direct = node[attribute]
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    try { return String(node.getAttribute(attribute) || '').trim() } catch { return '' }
  }
  const currentYoutube = youtubeIdentityFromUrl(location.href)
  const canonicalNode = document.querySelector('link[rel="canonical"]')
  const canonicalYoutube = youtubeIdentityFromUrl(elementValue(canonicalNode, 'href'))
  const titleMeta = document.querySelector(
    'meta[name="title"], meta[property="og:title"], meta[itemprop="name"]',
  )
  const canonicalTitle = elementValue(titleMeta, 'content') || String(document.title || '').trim()
  // Page identity is available only on a settled canonical watch/shorts page.
  // A results page with an unrelated advancing miniplayer must never inherit
  // the query title as playback proof.
  const youtube = currentYoutube
    && canonicalYoutube
    && currentYoutube.videoId === canonicalYoutube.videoId
    && canonicalTitle
    ? { ...currentYoutube, title: canonicalTitle }
    : null
  const youtubePlayerIdentity = (el) => {
    let player = null
    try { player = typeof el.closest === 'function' ? el.closest('.html5-video-player') : null } catch { /* no player */ }
    if (!player) return null
    let runtimeData = null
    try {
      runtimeData = typeof player.getVideoData === 'function' ? player.getVideoData() : null
    } catch { /* isolated-world or transient player state */ }
    let titleLink = null
    try { titleLink = player.querySelector('.ytp-title-link[href]') } catch { /* no title link */ }
    const linked = youtubeIdentityFromUrl(elementValue(titleLink, 'href'))
    const attributeVideoId = elementValue(player, 'data-video-id')
    const videoId = String(runtimeData && runtimeData.video_id || attributeVideoId || linked && linked.videoId || '').trim()
    const title = String(
      runtimeData && runtimeData.title
      || elementValue(titleLink, 'title')
      || elementValue(titleLink, 'aria-label')
      || titleLink && titleLink.textContent
      || '',
    ).trim()
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) && title ? { videoId, title } : null
  }
  const effectivelyPainted = (node) => {
    let opacity = 1
    for (let current = node; current; current = current.parentElement) {
      const currentStyle = getComputedStyle(current)
      if (
        currentStyle.display === 'none'
        || currentStyle.visibility === 'hidden'
        || currentStyle.visibility === 'collapse'
        || currentStyle.contentVisibility === 'hidden'
      ) return false
      const layerOpacity = Number.parseFloat(currentStyle.opacity)
      if (Number.isFinite(layerOpacity)) opacity *= layerOpacity
      if (opacity <= 0.01) return false
    }
    return true
  }
  const exposedAt = (el, x, y) => {
    if (typeof document.elementsFromPoint !== 'function') return false
    let stack
    try { stack = document.elementsFromPoint(x, y) } catch { return false }
    const mediaIndex = stack.indexOf(el)
    if (mediaIndex < 0) return false
    return stack.slice(0, mediaIndex).every((hit) => (
      el.contains(hit)
      || (typeof hit.contains === 'function' && hit.contains(el))
      || !effectivelyPainted(hit)
    ))
  }
  const mediaMetrics = mediaNodes.map((el, index) => {
      const rect = el.getBoundingClientRect()
      const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null
      const currentTime = Number.isFinite(el.currentTime) ? Math.round(el.currentTime * 10) / 10 : 0
      const clippedLeft = Math.max(0, rect.left)
      const clippedTop = Math.max(0, rect.top)
      const clippedRight = Math.min(window.innerWidth, rect.right)
      const clippedBottom = Math.min(window.innerHeight, rect.bottom)
      const clippedWidth = Math.max(0, clippedRight - clippedLeft)
      const clippedHeight = Math.max(0, clippedBottom - clippedTop)
      const insetX = Math.min(4, clippedWidth / 4)
      const insetY = Math.min(4, clippedHeight / 4)
      const points = clippedWidth > 0 && clippedHeight > 0
        ? [
            [(clippedLeft + clippedRight) / 2, (clippedTop + clippedBottom) / 2],
            [clippedLeft + insetX, clippedTop + insetY],
            [clippedRight - insetX, clippedTop + insetY],
            [clippedLeft + insetX, clippedBottom - insetY],
            [clippedRight - insetX, clippedBottom - insetY],
          ]
        : []
      const exposedPoints = points.map(([x, y]) => exposedAt(el, x, y))
      const exposedPointCount = exposedPoints.filter(Boolean).length
      const centerExposed = exposedPoints[0] === true
      const viewportArea = Math.round(clippedWidth * clippedHeight)
      const meaningfulViewport = clippedWidth >= 160 && clippedHeight >= 90 && viewportArea >= 14_400
      const substantialExposure = centerExposed && exposedPointCount >= 3
      const visible =
        meaningfulViewport
        && effectivelyPainted(el)
        && substantialExposure
      let mediaId = el.getAttribute('data-alma-media-id')
      if (!mediaId) {
        mediaId = typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `m-${Date.now().toString(36)}-${index}`
        el.setAttribute('data-alma-media-id', mediaId)
      }
      const youtubePlayer = youtubePlayerIdentity(el)
      return {
        index,
        mediaId,
        kind: el.tagName.toLowerCase(),
        playing: !el.paused && !el.ended && el.readyState >= 2,
        paused: el.paused,
        ended: el.ended,
        muted: el.muted,
        volume: Math.round(Number(el.volume || 0) * 100) / 100,
        currentTime,
        duration,
        readyState: el.readyState,
        visible,
        viewportWidth: Math.round(clippedWidth),
        viewportHeight: Math.round(clippedHeight),
        viewportArea,
        exposedPointCount,
        centerExposed,
        area: visible ? viewportArea : 0,
        ...(youtubePlayer ? {
          youtubeVideoId: youtubePlayer.videoId,
          youtubeTitle: youtubePlayer.title,
        } : {}),
      }
    })
  const primaryArea = Math.max(0, ...mediaMetrics.map((item) => item.area))
  const mediaItems = mediaMetrics.map(({ area, ...item }) => ({
    ...item,
    primary: area > 0 && area === primaryArea,
  }))
  // YouTube marks the player root while an ad owns the media clock. Without
  // this bit an advancing <video> could "prove" the requested song even though
  // the owner is still watching a pre-roll. Other sites simply report false.
  const adPlaying = Boolean(document.querySelector(
    '.html5-video-player.ad-showing, .html5-video-player.ad-interrupting',
  ))
  return {
    url: location.href,
    title: document.title,
    documentId: String(Math.round(performance.timeOrigin)),
    ...(youtube ? { youtube } : {}),
    text: t.slice(from, from + 12000),
    textLength: t.length,
    truncated: t.length > from + 12000,
    media: {
      count: mediaItems.length,
      playing: mediaItems.some((item) => item.playing),
      adPlaying,
      items: mediaItems,
    },
    scroll: {
      y: Math.round(window.scrollY),
      viewport: Math.round(window.innerHeight),
      pageHeight: Math.round(Math.max(doc ? doc.scrollHeight : 0, document.body ? document.body.scrollHeight : 0)),
      atBottom: window.scrollY + window.innerHeight >= Math.max(doc ? doc.scrollHeight : 0, document.body ? document.body.scrollHeight : 0) - 4,
    },
  }
}

async function pageReadDom(arg) {
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Boolean(effectNonce)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  const expectedCurrentUrl = String(arg && arg.expectedCurrentUrl || '')
  const expectedDocumentId = String(arg && arg.expectedDocumentId || '')
  let currentUrl = ''
  let currentDocumentId = ''
  try {
    currentUrl = String(location.href)
    currentDocumentId = String(Math.round(performance.timeOrigin))
  } catch { /* blocked below */ }
  const exactObservationRequired = Boolean(arg && (
    Object.prototype.hasOwnProperty.call(arg, 'expectedCurrentUrl')
    || Object.prototype.hasOwnProperty.call(arg, 'expectedDocumentId')
  ))
  // Ref generation mutates the page, so bind the identity before even
  // stamping the observation root or inspecting one DOM element.
  if (
    exactObservationRequired
    && (
      !expectedCurrentUrl
      || !expectedDocumentId
      || currentUrl !== expectedCurrentUrl
      || currentDocumentId !== expectedDocumentId
    )
  ) {
    return { __almaObservationBlocked: true }
  }
  const requiredHost = String(arg && arg.requiredHost || '').trim().toLowerCase().replace(/^www\./, '')
  if (requiredHost) {
    let host = ''
    try { host = location.hostname.toLowerCase().replace(/^www\./, '') } catch { /* blocked below */ }
    if (host !== requiredHost) {
      return { __almaHostBlocked: true }
    }
  }
  if (!(await liveEffectStillAuthorized())) return { __almaEffectBlocked: true }
  if (!effectStillAuthorized()) return { __almaEffectBlocked: true }
  const out = []
  const domObservationId =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  // Changing this root stamp invalidates every earlier receipt immediately,
  // even if a later part of this LOOK fails before the server stores a nonce.
  document.documentElement.setAttribute('data-alma-observation-id', domObservationId)
  // Refs authorize exactly one subsequent receipt-bound action. Clear the
  // previous observation's stamps so an old e1 cannot silently resolve after a
  // new look has assigned e1 to a different node in the same SPA document.
  for (const old of Array.from(document.querySelectorAll('[data-alma-ref]'))) {
    try {
      old.removeAttribute('data-alma-ref')
      old.removeAttribute('data-alma-observation-id')
    } catch { /* detached/frozen node */ }
  }
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
    // Hidden file inputs are intentionally activated by a visible Upload/Add
    // button. Include them in the observation so upload_file can still bind to
    // an exact receipt ref instead of falling back to an arbitrary input.
    const receiptTarget = el.tagName === 'INPUT' && el.getAttribute('type') === 'file'
    if (r.width === 0 && r.height === 0 && !receiptTarget) continue
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
      el.setAttribute('data-alma-observation-id', domObservationId)
    } catch {
      /* frozen node — ignore */
    }
    const fingerprint = JSON.stringify([
      el.tagName.toLowerCase(),
      el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : ''),
      el.getAttribute('role') || '',
      el.getAttribute('name') || '',
      el.getAttribute('aria-label') || '',
      (
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
          ? (el.placeholder || '')
          : (el.innerText || el.value || '')
      ).trim().replace(/\s+/g, ' ').slice(0, 120),
      el.getAttribute('href') || '',
    ])
    out.push({
      ref,
      fingerprint,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : null),
      role: el.getAttribute('role') || null,
      name: el.getAttribute('name') || el.getAttribute('aria-label') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      href: el.getAttribute('href') || null,
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
  return {
    url: location.href,
    title: document.title,
    documentId: String(Math.round(performance.timeOrigin)),
    domObservationId,
    elements: out,
  }
}

function pageObservationIdentity() {
  return {
    url: location.href,
    documentId: String(Math.round(performance.timeOrigin)),
    domObservationId: document.documentElement.getAttribute('data-alma-observation-id') || '',
  }
}

// Live status banner + moving cursor dot — injected so the owner SEES the agent
// working end-to-end, Claude-extension style. Self-contained, pointer-events off.
async function pageOverlay(arg) {
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Boolean(effectNonce)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized()) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: overlay mutation revoked' }
  }
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
          chrome.storage.local.set({ paused: true, commandDispatchNonce: '' })
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
  const {
    selector, text, ref, domObservationId, refFingerprint, expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  const effectExpired = () => ({
    ok: false,
    blocked: true,
    error: 'command_effect_expired: click mutation revoked',
  })
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  let el = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      el = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch {
      el = null
    }
    if (!el || fingerprintOf(el) !== String(refFingerprint || '')) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed node changed' }
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
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before click' }
  }
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before click' }
  }
  if (!effectStillAuthorized()) return effectExpired()
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await sleep(350)
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_ref_generation_failed: DOM observation changed before click' }
  }
  if (!effectStillAuthorized()) return effectExpired()
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
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_ref_generation_failed: DOM observation changed before click' }
  }
  if (!effectStillAuthorized()) return effectExpired()
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
  const {
    selector, text, value, submit, ref, domObservationId, refFingerprint,
    expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  const effectExpired = () => ({
    ok: false,
    blocked: true,
    error: 'command_effect_expired: type mutation revoked',
  })
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
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
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      el = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch {
      el = null
    }
    if (!el || !receiptTargetStillValid(el)) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed field changed' }
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
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: field changed before typing' }
  }
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: field changed before typing' }
  }
  if (!effectStillAuthorized()) return effectExpired()
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus()
  const prevOutline = el.style.outline
  el.style.outline = '3px solid #c9a84c'
  el.style.outlineOffset = '2px'
  await sleep(300)
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: field changed before typing' }
  }
  // Human-paced typing: grow the value in a few chunks so the owner watches the
  // text being "typed" — each chunk still goes through the framework-safe setter
  // (React/Vue keep the final value), so this is purely visual pacing.
  const fullText = value == null ? '' : String(value)
  if (fullText.length > 3 && fullText.length <= 200) {
    const chunks = Math.min(6, Math.max(3, Math.ceil(fullText.length / 18)))
    for (let ci = 1; ci < chunks; ci++) {
      if (!(await liveEffectStillAuthorized())) return effectExpired()
      if (!receiptTargetStillValid(el)) {
        return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: field changed while typing' }
      }
      if (!effectStillAuthorized()) return effectExpired()
      almaSetValue(el, fullText.slice(0, Math.ceil((fullText.length * ci) / chunks)))
      await sleep(90 + Math.random() * 120)
    }
  }
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: field changed before final value' }
  }
  if (!effectStillAuthorized()) return effectExpired()
  almaSetValue(el, fullText)
  if (submit) {
    await sleep(150)
    if (!(await liveEffectStillAuthorized())) return effectExpired()
    if (!receiptTargetStillValid(el)) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: field changed before submit' }
    }
    if (!effectStillAuthorized()) return effectExpired()
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

async function pageKey(arg) {
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Boolean(effectNonce)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized()) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: key mutation revoked' }
  }
  const expectedCurrentUrl = arg && arg.expectedCurrentUrl
  const expectedDocumentId = arg && arg.expectedDocumentId
  const domObservationId = arg && arg.domObservationId
  if (
    (expectedCurrentUrl && String(location.href) !== String(expectedCurrentUrl))
    || (expectedDocumentId && String(Math.round(performance.timeOrigin)) !== String(expectedDocumentId))
    || (domObservationId
      && document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId))
  ) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
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
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: key mutation revoked' }
  }
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
async function pageSelect(arg) {
  const {
    selector, text, ref, option, value, domObservationId, refFingerprint,
    expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: select mutation revoked' }
  }
  const want = String((option != null ? option : value) == null ? '' : option != null ? option : value)
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  let el = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      el = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch {
      el = null
    }
    if (!el || fingerprintOf(el) !== String(refFingerprint || '')) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed select changed' }
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
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: select changed before effect' }
  }
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: select mutation revoked' }
  }
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: select changed before effect' }
  }
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: select mutation revoked' }
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
  const {
    selector, text, ref, option, domObservationId, refFingerprint,
    expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  const effectExpired = () => ({
    ok: false,
    blocked: true,
    error: 'command_effect_expired: dropdown mutation revoked',
  })
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTriggerStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  const fire = (el) => {
    if (!effectStillAuthorized()) return false
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
    return true
  }
  // 1) locate the dropdown trigger (ref → selector → visible text/label)
  let trigger = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      trigger = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch { trigger = null }
    if (!trigger || !receiptTriggerStillValid(trigger)) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed dropdown changed' }
    }
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
        if (!observationDocumentStillValid()) {
          return { ok: false, blocked: true, error: 'observation_document_changed: page changed before trigger effect' }
        }
        if (!(await liveEffectStillAuthorized())) return effectExpired()
        if (!observationDocumentStillValid()) {
          return { ok: false, blocked: true, error: 'observation_document_changed: page changed before trigger effect' }
        }
        if (!effectStillAuthorized() || !fire(chip)) return effectExpired()
        for (let i = 0; i < 8; i++) {
          await sleep(300)
          if (!(await liveEffectStillAuthorized())) return effectExpired()
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
  if (trigger.tagName === 'SELECT') {
    return pageSelect({
      selector, text, ref, option, domObservationId, refFingerprint,
      expectedCurrentUrl, expectedDocumentId,
      __almaDispatchGeneration: effectGeneration,
      __almaDispatchNonce: effectNonce,
      __almaEffectDeadlineMs: effectDeadlineMs,
    })
  }
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: dropdown changed before opening' }
  }
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: dropdown changed before opening' }
  }
  if (!effectStillAuthorized()) return effectExpired()
  trigger.scrollIntoView({ block: 'center' })
  await sleep(200)
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: dropdown changed before opening' }
  }
  if (!effectStillAuthorized() || !fire(trigger)) return effectExpired()
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
    if (!(await liveEffectStillAuthorized())) return effectExpired()
    if (!receiptTriggerStillValid(trigger)) {
      return { ok: false, blocked: true, error: 'observation_document_changed: page changed while opening dropdown' }
    }
    target = findOption()
  }
  if (!target) {
    // leave the menu as we found it (Escape) and report what WAS visible
    const seen = Array.from(document.querySelectorAll('[role=option],[role=menuitem]'))
      .filter(visible)
      .slice(0, 12)
      .map((e) => (e.innerText || '').trim().slice(0, 60))
    return {
      ok: false,
      error: 'dropdown option unavailable after trigger effect: ' + want,
      optionsSeen: seen,
    }
  }
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: page changed before option scroll' }
  }
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: page changed before option scroll' }
  }
  if (!effectStillAuthorized()) return effectExpired()
  target.scrollIntoView({ block: 'center' })
  await sleep(150)
  if (!(await liveEffectStillAuthorized())) return effectExpired()
  if (!receiptTriggerStillValid(trigger)) {
    return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: dropdown changed before option click' }
  }
  if (!effectStillAuthorized() || !fire(target)) return effectExpired()
  await sleep(400)
  return { ok: true, picked: (target.innerText || '').trim().slice(0, 80) }
}

// Put a real File into a page's <input type="file"> — the DataTransfer trick.
// The service worker fetches the bytes (page CSP can't); this injected half
// rebuilds the File and fires the change events frameworks listen for. This is
// what lets the agent attach its own generated images (e.g. carousel creatives)
// instead of stopping to ask the owner to drag files in.
async function pageUploadFile(arg) {
  const {
    selector, text, ref, b64, filename, mime, domObservationId, refFingerprint,
    expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: upload mutation revoked' }
  }
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 || r.height > 0 || e.type === 'file' // file inputs are often hidden
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  let input = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      input = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch { input = null }
    if (!input || fingerprintOf(input) !== String(refFingerprint || '')) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed file input changed' }
    }
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
  if (!receiptTargetStillValid(input)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: file input changed before effect' }
  }
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: upload mutation revoked' }
  }
  if (!receiptTargetStillValid(input)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: file input changed before effect' }
  }
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: upload mutation revoked' }
  }
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, attached: file.name, totalFiles: input.files.length, multiple: Boolean(input.multiple) }
}

// Bring a specific element into view (center) so the next click/read is precise
// on a long page. Targets by ref → selector → visible text.
async function pageScrollTo(arg) {
  const {
    selector, text, ref, domObservationId, refFingerprint, expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  let el = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      el = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch {
      el = null
    }
    if (!el || fingerprintOf(el) !== String(refFingerprint || '')) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed target changed' }
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
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before scroll' }
  }
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before scroll' }
  }
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  return { ok: true, scrolledTo: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60) }
}

async function pageScroll(arg) {
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Boolean(effectNonce)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized()) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  const expectedCurrentUrl = arg && arg.expectedCurrentUrl
  const expectedDocumentId = arg && arg.expectedDocumentId
  const domObservationId = arg && arg.domObservationId
  if (
    (expectedCurrentUrl && String(location.href) !== String(expectedCurrentUrl))
    || (expectedDocumentId && String(Math.round(performance.timeOrigin)) !== String(expectedDocumentId))
    || (domObservationId
      && document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId))
  ) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  const by = Number(arg && arg.by) || 600
  // 'instant' (not smooth): the server's sweep loop reads right after scrolling,
  // and a smooth scroll is still mid-flight when the read fires.
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  if (
    (expectedCurrentUrl && String(location.href) !== String(expectedCurrentUrl))
    || (expectedDocumentId && String(Math.round(performance.timeOrigin)) !== String(expectedDocumentId))
    || (domObservationId
      && document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId))
  ) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: scroll mutation revoked' }
  }
  window.scrollBy({ top: by, behavior: 'instant' })
  const doc = document.documentElement
  const pageHeight = Math.max(doc ? doc.scrollHeight : 0, document.body ? document.body.scrollHeight : 0)
  return {
    ok: true,
    scrolledBy: by,
    scroll: {
      y: Math.round(window.scrollY),
      viewport: Math.round(window.innerHeight),
      pageHeight: Math.round(pageHeight),
      atBottom: window.scrollY + window.innerHeight >= pageHeight - 4,
    },
  }
}

// Move the mouse over an element (by ref → selector → visible text) to reveal
// hover-only menus / tooltips before clicking them. Dispatches the full pointer +
// mouse enter/over sequence so hover-driven UIs (dropdown menus, submenus) open.
async function pageHover(arg) {
  const {
    selector, text, ref, domObservationId, refFingerprint, expectedCurrentUrl, expectedDocumentId,
  } = arg
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized() || !effectNonce) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: hover mutation revoked' }
  }
  const visible = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fingerprintOf = (node) => JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
  const observationDocumentStillValid = () => (
    (!expectedCurrentUrl || String(location.href) === String(expectedCurrentUrl))
    && (!expectedDocumentId || String(Math.round(performance.timeOrigin)) === String(expectedDocumentId))
    && (!domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') === String(domObservationId))
  )
  const receiptTargetStillValid = (node) => observationDocumentStillValid() && (!ref || (
    node.getAttribute('data-alma-observation-id') === String(domObservationId)
    && fingerprintOf(node) === String(refFingerprint || '')
  ))
  if (!observationDocumentStillValid()) {
    return { ok: false, blocked: true, error: 'observation_document_changed: run a new LOOK' }
  }
  let el = null
  if (ref) {
    if (
      !domObservationId
      || document.documentElement.getAttribute('data-alma-observation-id') !== String(domObservationId)
    ) {
      return { ok: false, blocked: true, error: 'observation_ref_generation_failed: run a new LOOK' }
    }
    try {
      el = document.querySelector(
        '[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]' +
        '[data-alma-observation-id="' + String(domObservationId).replace(/"/g, '') + '"]',
      )
    } catch {
      el = null
    }
    if (!el || fingerprintOf(el) !== String(refFingerprint || '')) {
      return { ok: false, blocked: true, error: 'observation_ref_fingerprint_failed: observed target changed' }
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
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before hover' }
  }
  if (!(await liveEffectStillAuthorized()) || !effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: hover mutation revoked' }
  }
  if (!receiptTargetStillValid(el)) {
    return { ok: false, blocked: true, error: 'observation_document_changed: target changed before hover' }
  }
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: hover mutation revoked' }
  }
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

// Receipt-bound navigation must validate and mutate in ONE renderer task. A
// tabs.get/executeScript check followed later by chrome.tabs.update leaves a
// gap where the owner or an SPA can move to another page and the stale command
// can overwrite it. location.assign is invoked synchronously only after the
// current renderer proves it is still the observed document/generation.
async function pageNavigateAtomic(arg) {
  const effectGeneration = Number(arg && arg.__almaDispatchGeneration)
  const effectNonce = String(arg && arg.__almaDispatchNonce || '')
  const effectDeadlineMs = Number(arg && arg.__almaEffectDeadlineMs)
  const effectStillAuthorized = () => (
    Number.isSafeInteger(effectGeneration)
    && Boolean(effectNonce)
    && Number.isFinite(effectDeadlineMs)
    && Date.now() < effectDeadlineMs
  )
  const liveEffectStillAuthorized = async () => {
    if (!effectStillAuthorized()) return false
    try {
      const state = await chrome.storage.local.get([
        'paused', 'token', 'commandDispatchGeneration', 'commandDispatchNonce',
      ])
      return (
        effectStillAuthorized()
        && state.paused !== true
        && typeof state.token === 'string'
        && Boolean(state.token)
        && Number(state.commandDispatchGeneration) === effectGeneration
        && String(state.commandDispatchNonce || '') === effectNonce
      )
    } catch {
      return false
    }
  }
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: navigation mutation revoked' }
  }
  const targetUrl = String(arg && arg.targetUrl || '')
  const expectedCurrentUrl = String(arg && arg.expectedCurrentUrl || '')
  const expectedDocumentId = String(arg && arg.expectedDocumentId || '')
  const expectedDomObservationId = String(arg && arg.domObservationId || '')
  if (!(await liveEffectStillAuthorized())) {
    return { ok: false, blocked: true, error: 'command_effect_expired: navigation mutation revoked' }
  }
  const liveDomObservationId = document.documentElement
    ? String(document.documentElement.getAttribute('data-alma-observation-id') || '')
    : ''
  if (
    !targetUrl
    || !expectedCurrentUrl
    || !expectedDocumentId
    || String(location.href) !== expectedCurrentUrl
    || String(Math.round(performance.timeOrigin)) !== expectedDocumentId
    || (expectedDomObservationId && liveDomObservationId !== expectedDomObservationId)
  ) {
    return {
      ok: false,
      blocked: true,
      error: 'observation_document_changed: page identity changed before navigation',
    }
  }
  const previousUrl = String(location.href)
  if (!effectStillAuthorized()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: navigation mutation revoked' }
  }
  location.assign(targetUrl)
  return { ok: true, url: targetUrl, previousUrl }
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
  // A timed-out executeScript promise is not canceled by Chrome. Cap the page's
  // own synchronous mutation guard to this individual injection, not merely to
  // the wider command deadline, so a script that starts after our 15s failure
  // result has already won is guaranteed to be inert.
  const guardedArg = arg && typeof arg === 'object' && Number.isFinite(arg.__almaEffectDeadlineMs)
    ? {
        ...arg,
        __almaEffectDeadlineMs: Math.min(
          arg.__almaEffectDeadlineMs,
          Date.now() + PAGE_SCRIPT_TIMEOUT_MS,
        ),
      }
    : arg
  const run = chrome.scripting
    .executeScript({ target: { tabId }, func, args: guardedArg ? [guardedArg] : [] })
    .then(([res]) => (res ? res.result : null))
  return withTimeout(run, PAGE_SCRIPT_TIMEOUT_MS, 'page script')
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
async function actWithRetry(
  tabId,
  func,
  arg,
  observationPrecondition,
  isCurrent = () => true,
  effectAuthority = { dispatchGeneration: 0, dispatchNonce: '', deadlineMs: Number.MAX_SAFE_INTEGER },
) {
  const effectCurrent = () => (
    isCurrent()
    && Number.isSafeInteger(effectAuthority.dispatchGeneration)
    && typeof effectAuthority.dispatchNonce === 'string'
    && Boolean(effectAuthority.dispatchNonce)
    && Number.isFinite(effectAuthority.deadlineMs)
    && Date.now() < effectAuthority.deadlineMs
  )
  const expired = () => ({
    ok: false,
    blocked: true,
    error: 'command_effect_expired: Pause, Unpair, or command deadline revoked this page mutation',
  })
  const refBound = Boolean(arg && arg.ref)
  const refFingerprint = refBound
    ? String(
        observationPrecondition
        && observationPrecondition.refFingerprints
        && observationPrecondition.refFingerprints[String(arg.ref)]
        || '',
      )
    : ''
  const boundArg = {
    ...(observationPrecondition
      ? {
        ...arg,
        expectedCurrentUrl: observationPrecondition.currentUrl,
        expectedDocumentId: observationPrecondition.documentId,
        domObservationId: observationPrecondition.domObservationId,
        refFingerprint,
      }
      : arg),
    __almaDispatchGeneration: effectAuthority.dispatchGeneration,
    __almaDispatchNonce: effectAuthority.dispatchNonce,
    __almaEffectDeadlineMs: effectAuthority.deadlineMs,
  }
  if (!effectCurrent()) return expired()
  if (observationPrecondition) {
    const gate = await verifyObservationPrecondition(tabId, observationPrecondition, refBound)
    if (!gate.ok) return gate
    if (!effectCurrent()) return expired()
  }
  if (!effectCurrent()) return expired()
  let last = await runInPage(tabId, func, boundArg)
  if (last && last.ok) return last
  const provenPreEffectMiss = (result) => Boolean(
    result
    && result.ok === false
    && result.blocked !== true
    && /^(?:element not found(?: to (?:scroll to|hover))?|field not found|select not found|dropdown trigger not found|option not found(?::.*)?|file input not found(?:\s+—.*)?)$/i
      .test(String(result.error || '').trim()),
  )
  // A timeout/unknown result may have landed after the page effect. Retrying it
  // can double-click/type/upload, so only deterministic pre-effect misses are
  // eligible for another dispatch.
  if (!provenPreEffectMiss(last)) return last
  for (let i = 0; i < 3 && provenPreEffectMiss(last); i++) {
    await new Promise((r) => setTimeout(r, 450))
    if (!effectCurrent()) return expired()
    if (observationPrecondition) {
      const gate = await verifyObservationPrecondition(tabId, observationPrecondition, refBound)
      if (!gate.ok) return gate
      if (!effectCurrent()) return expired()
    }
    if (!effectCurrent()) return expired()
    last = await runInPage(tabId, func, boundArg)
  }
  if (last && last.ok) return last
  if (!provenPreEffectMiss(last)) return last
  // Receipt refs were observed in the top document. Falling through to every
  // iframe could resolve a colliding e1 in an unobserved document.
  if (observationPrecondition) return last
  if (!effectCurrent()) return expired()
  const alt = await runInAllFrames(tabId, func, boundArg)
  if (alt && alt.ok) return alt
  return last || alt
}

async function verifyObservationPrecondition(tabId, precondition, requireDomObservationId = false) {
  const expectedUrl = String(precondition && precondition.currentUrl || '')
  const expectedDocumentId = String(precondition && precondition.documentId || '')
  const expectedDomObservationId = String(precondition && precondition.domObservationId || '')
  if (!expectedUrl || !expectedDocumentId || (requireDomObservationId && !expectedDomObservationId)) {
    return {
      ok: false,
      blocked: true,
      error: 'observation_precondition_missing: URL/document/required DOM generation identity missing',
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const tabUrl = String(tab && (tab.pendingUrl || tab.url) || '')
  if (!tab || tabUrl !== expectedUrl) {
    return {
      ok: false,
      blocked: true,
      error: `observation_precondition_failed: active agent tab URL changed (expected ${expectedUrl}, got ${tabUrl || 'missing'})`,
    }
  }
  const identity = await runInPage(tabId, pageObservationIdentity)
  if (
    !identity
    || identity.ok === false
    || String(identity.url || '') !== expectedUrl
    || String(identity.documentId || '') !== expectedDocumentId
    || (expectedDomObservationId && String(identity.domObservationId || '') !== expectedDomObservationId)
  ) {
    return {
      ok: false,
      blocked: true,
      error: 'observation_precondition_failed: active document changed after LOOK; run a new live_browser_look',
    }
  }
  return { ok: true }
}

// Stamp mute + foreground state only AFTER the injected media sample returns.
// Pre-sample state has a TOCTOU window: the owner can mute, switch tabs, or move
// focus to another window while executeScript is in flight.
async function readPageTextWithPostSampleMute(
  tabId,
  from,
  requireForeground,
  requiredHost,
  expectedCurrentUrl,
  expectedDocumentId,
  requireExactObservation = false,
  isCurrent = () => true,
) {
  const expectedUrl = String(expectedCurrentUrl || '')
  const expectedDocument = String(expectedDocumentId || '')
  const exactObservationRequired = requireExactObservation === true
    || Boolean(expectedUrl || expectedDocument)
  if (exactObservationRequired && (!expectedUrl || !expectedDocument)) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_missing: expected URL/document identity required',
    }
  }
  if (requireForeground === true) {
    const before = await chrome.tabs.get(tabId).catch(() => null)
    if (!isCurrent()) {
      return { ok: false, blocked: true, error: 'command_effect_expired: foreground mutation revoked' }
    }
    if (!before || !Number.isInteger(before.windowId)) {
      return { ok: false, error: 'foreground_witness_unavailable: tab/window state is missing' }
    }
    try {
      if (!isCurrent()) {
        return { ok: false, blocked: true, error: 'command_effect_expired: foreground mutation revoked' }
      }
      await chrome.windows.update(before.windowId, { focused: true })
      if (!isCurrent()) {
        return { ok: false, blocked: true, error: 'command_effect_expired: foreground mutation revoked' }
      }
      await chrome.tabs.update(tabId, { active: true })
    } catch {
      return { ok: false, error: 'foreground_witness_unavailable: could not foreground the agent tab' }
    }
  }
  const data = await runInPage(tabId, pageReadText, {
    from,
    requiredHost,
    ...(exactObservationRequired ? {
      expectedCurrentUrl: expectedUrl,
      expectedDocumentId: expectedDocument,
    } : {}),
  })
  if (!isCurrent()) {
    return { ok: false, blocked: true, error: 'command_effect_expired: page read continuation revoked' }
  }
  if (data && data.__almaObservationBlocked) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_failed: page changed; text was not returned',
    }
  }
  if (data && data.__almaHostBlocked) {
    return { ok: false, blocked: true, error: 'required_host_mismatch: page text was not read' }
  }
  if (
    exactObservationRequired
    && (
      !data
      || String(data.url || '') !== expectedUrl
      || String(data.documentId || '') !== expectedDocument
    )
  ) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_failed: page changed; text was not returned',
    }
  }
  const postSampleTab = await chrome.tabs.get(tabId).catch(() => null)
  const postSampleWindow = postSampleTab && Number.isInteger(postSampleTab.windowId)
    ? await chrome.windows.get(postSampleTab.windowId).catch(() => null)
    : null
  if (!postSampleTab || !postSampleWindow) {
    return {
      ok: false,
      error: 'post_sample_browser_state_unavailable: tab/window state could not be verified after media observation',
    }
  }
  const postSampleUrl = String(postSampleTab.pendingUrl || postSampleTab.url || '')
  if (exactObservationRequired && postSampleUrl !== expectedUrl) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_failed: page changed after sampling; text was not returned',
    }
  }
  if (data && data.media) {
    data.media.tabMuted = Boolean(postSampleTab.mutedInfo && postSampleTab.mutedInfo.muted)
    data.media.tabActive = postSampleTab.active === true
    data.media.windowFocused = postSampleWindow.focused === true
  }
  if (
    requireForeground === true
    && (postSampleTab.active !== true || postSampleWindow.focused !== true)
  ) {
    return {
      ok: false,
      error: 'foreground_witness_failed: agent tab/window lost foreground during media observation',
    }
  }
  return { ok: true, data }
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
async function showOverlay(
  tabId,
  label,
  isCurrent = () => true,
  effectAuthority = { dispatchGeneration: 0, dispatchNonce: '', deadlineMs: Number.MAX_SAFE_INTEGER },
) {
  if (
    !isCurrent()
    || !Number.isSafeInteger(effectAuthority.dispatchGeneration)
    || typeof effectAuthority.dispatchNonce !== 'string'
    || !effectAuthority.dispatchNonce
    || !Number.isFinite(effectAuthority.deadlineMs)
    || Date.now() >= effectAuthority.deadlineMs
  ) return false
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOverlay,
      args: [{
        label,
        __almaDispatchGeneration: effectAuthority.dispatchGeneration,
        __almaDispatchNonce: effectAuthority.dispatchNonce,
        __almaEffectDeadlineMs: effectAuthority.deadlineMs,
      }],
    })
    return isCurrent() && Date.now() < effectAuthority.deadlineMs
  } catch {
    /* page not scriptable yet — ignore */
    return false
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
const RECEIPT_REF_ACTIONS = new Set(['click', 'type', 'select_option', 'pick_option', 'upload_file', 'hover', 'scroll_to'])

// ---- CDP screenshots (chrome.debugger) ---------------------------------------
// captureVisibleTab only shoots the ACTIVE tab of a window; now that the agent
// works in a grouped tab of the owner's own window, the tab is often in the
// background. The debugger path captures the agent tab regardless of focus —
// the same mechanism Claude-in-Chrome uses (Chrome shows its standard
// "…is debugging this browser" bar while attached; it clears on detach).

async function performDebuggerRecovery(tabId) {
  if (debuggerPoisoned) return false
  try {
    await withPreviewDeadline(
      chrome.debugger.detach({ tabId }),
      CDP_RECOVERY_TIMEOUT_MS,
      'Chrome debugger recovery',
    )
  } catch (err) {
    // "Not attached" is already recovered. A detach call that itself hangs is
    // not safe to overlap with more CDP work: fail closed and reload only after
    // any in-flight command result is durably delivered.
    if (err instanceof PreviewDeadlineError) {
      poisonDebuggerAndReload()
      return false
    }
  }
  try {
    await withPreviewDeadline(
      chrome.storage.local.remove('cdpTabId'),
      CDP_RECOVERY_TIMEOUT_MS,
      'Chrome debugger state cleanup',
    )
    return true
  } catch {
    poisonDebuggerAndReload()
    return false
  }
}

async function recoverDebuggerConnection(tabId, isCurrent = () => true) {
  const recovered = await debuggerRecoveryQueue.run(tabId)
  if (!recovered) {
    stopPreviewCapture()
    await applyPendingReloadIfQuiescent()
  }
  return recovered && isCurrent()
}

async function waitForDebuggerRecovery(isCurrent = () => true) {
  await debuggerRecoveryQueue.waitForIdle()
  return !debuggerPoisoned && isCurrent()
}

async function ensureDebugger(tabId, isCurrent = () => true, timeoutMs = DEBUGGER_ATTACH_TIMEOUT_MS) {
  if (debuggerPoisoned) return false
  if (!(await waitForDebuggerRecovery(isCurrent))) return false
  if (!isCurrent()) return false
  let cdpTabId
  try {
    ;({ cdpTabId } = await withPreviewDeadline(
      chrome.storage.local.get('cdpTabId'),
      timeoutMs,
      'Chrome debugger state read',
    ))
  } catch {
    poisonDebuggerAndReload()
    return false
  }
  if (!isCurrent()) return false
  if (cdpTabId != null && cdpTabId !== tabId) {
    if (!(await recoverDebuggerConnection(cdpTabId, isCurrent))) return false
  }
  if (!isCurrent()) return false
  try {
    await withPreviewDeadline(
      chrome.debugger.attach({ tabId }, '1.3'),
      timeoutMs,
      'Chrome debugger attach',
    )
    if (!isCurrent()) {
      // This call created the attachment but cancellation landed before its
      // identity was persisted. Detach that exact tab now; otherwise it becomes
      // an untracked Chrome debugging session and a later tab can attach beside it.
      await recoverDebuggerConnection(tabId)
      return false
    }
    await withPreviewDeadline(
      chrome.storage.local.set({ cdpTabId: tabId }),
      timeoutMs,
      'Chrome debugger state write',
    )
    return true
  } catch (err) {
    if (/already attached/i.test(String(err && err.message))) {
      if (!isCurrent()) return false
      try {
        await withPreviewDeadline(
          chrome.storage.local.set({ cdpTabId: tabId }),
          timeoutMs,
          'Chrome debugger state write',
        )
        return isCurrent()
      } catch {
        poisonDebuggerAndReload()
        return false
      }
    }
    if (err instanceof PreviewDeadlineError) {
      poisonDebuggerAndReload()
    }
    return false
  }
}

async function captureAgentTabExclusive(
  tab,
  quality = 80,
  callTimeoutMs = COMMAND_CAPTURE_CALL_TIMEOUT_MS,
  isCurrent = () => true,
  allowVisibleFallback = true,
) {
  if (debuggerPoisoned || !isCurrent()) return null
  // 1) CDP — works even when the agent tab is in the background.
  if (await ensureDebugger(tab.id, isCurrent, Math.min(callTimeoutMs, DEBUGGER_ATTACH_TIMEOUT_MS))) {
    if (!isCurrent()) {
      await recoverDebuggerConnection(tab.id)
      return null
    }
    let rawCapture = null
    try {
      rawCapture = chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality,
      })
      const shot = await withPreviewDeadline(
        rawCapture,
        callTimeoutMs,
        'Chrome screenshot capture',
      )
      if (!isCurrent()) return null
      if (shot && shot.data) return 'data:image/jpeg;base64,' + shot.data
    } catch (err) {
      // One timed-out CDP request is actively detached and fully serialized.
      // Do not retry it in the same tick; the next tick starts only after this
      // recovery settles, preventing abandoned Page.captureScreenshot buildup.
      if (err instanceof PreviewDeadlineError && rawCapture) {
        const drained = await recoverTimedOutOperation(
          rawCapture,
          () => recoverDebuggerConnection(tab.id),
          CDP_DRAIN_TIMEOUT_MS,
          'timed-out Chrome screenshot cleanup',
        )
        if (!drained) {
          poisonDebuggerAndReload()
          return null
        }
      } else if (!(await recoverDebuggerConnection(tab.id))) {
        return null
      }
      if (debuggerPoisoned || !isCurrent()) return null
    }
  }
  if (debuggerPoisoned || !allowVisibleFallback) return null
  // 2) Fallback — visible-tab capture; only right when the agent tab is active
  //    (e.g. the owner revoked the debugger permission or DevTools is attached).
  try {
    if (!isCurrent()) return null
    // captureVisibleTab photographs the WINDOW'S foreground tab, not the tab
    // argument. Never upload an unrelated owner tab under the agent context.
    const activeTabs = await withPreviewDeadline(
      chrome.tabs.query({ active: true, windowId: tab.windowId }),
      VISIBLE_TAB_LOOKUP_TIMEOUT_MS,
      'visible tab lookup',
    )
    if (!isCurrent()) return null
    if (!activeTabs.some((activeTab) => activeTab.id === tab.id)) return null
    const shot = await withPreviewDeadline(
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality }),
      callTimeoutMs,
      'visible tab screenshot capture',
    )
    return isCurrent() ? shot : null
  } catch {
    return null
  }
}

async function captureAgentTab(
  tab,
  quality = 80,
  callTimeoutMs = COMMAND_CAPTURE_CALL_TIMEOUT_MS,
  isCurrent = () => true,
  allowVisibleFallback = true,
) {
  return cdpOperationQueue.run(() => captureAgentTabExclusive(
    tab,
    quality,
    callTimeoutMs,
    isCurrent,
    allowVisibleFallback,
  ))
}

async function captureExactObservedScreenshot(tab, cmd, isCurrent = () => true) {
  const expectedUrl = String(cmd && cmd.expectedCurrentUrl || '')
  const expectedDocumentId = String(cmd && cmd.expectedDocumentId || '')
  const exactObservationRequired = Boolean(cmd && (
    Object.prototype.hasOwnProperty.call(cmd, 'expectedCurrentUrl')
    || Object.prototype.hasOwnProperty.call(cmd, 'expectedDocumentId')
  ))
  if (exactObservationRequired && (!expectedUrl || !expectedDocumentId)) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_missing: expected URL/document identity required',
    }
  }
  const requiredHost = String(cmd && cmd.requiredHost || '').trim().toLowerCase().replace(/^www\./, '')
  const hostAllowed = (identity) => {
    if (!requiredHost || !identity || !identity.url) return !requiredHost
    try {
      const host = new URL(identity.url).hostname.toLowerCase().replace(/^www\./, '')
      return host === requiredHost
    } catch { return false }
  }
  const identityAllowed = (identity) => Boolean(
    identity
    && String(identity.url || '') === expectedUrl
    && String(identity.documentId || '') === expectedDocumentId
  )

  // CDP/visible-tab capture is outside the page renderer task. Bracket it with
  // exact document checks and discard the bytes if either edge disagrees.
  const beforeIdentity = exactObservationRequired || requiredHost
    ? await runInPage(tab.id, pageObservationIdentity).catch(() => null)
    : null
  if (exactObservationRequired && !identityAllowed(beforeIdentity)) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_failed: page changed; screenshot was not captured',
    }
  }
  if (requiredHost && !hostAllowed(beforeIdentity)) {
    return { ok: false, blocked: true, error: 'required_host_mismatch: screenshot was not captured' }
  }

  const dataUrl = await captureAgentTab(
    tab,
    80,
    COMMAND_CAPTURE_CALL_TIMEOUT_MS,
    isCurrent,
    true,
  )
  if (!dataUrl) return { ok: false, error: 'could not capture screenshot' }

  const afterIdentity = exactObservationRequired || requiredHost
    ? await runInPage(tab.id, pageObservationIdentity).catch(() => null)
    : null
  if (exactObservationRequired && !identityAllowed(afterIdentity)) {
    return {
      ok: false,
      blocked: true,
      error: 'read_observation_precondition_failed: page changed; screenshot was discarded',
    }
  }
  if (requiredHost && !hostAllowed(afterIdentity)) {
    return {
      ok: false,
      blocked: true,
      error: 'required_host_mismatch: screenshot document changed and was discarded',
    }
  }
  if (
    requiredHost
    && !exactObservationRequired
    && (
      String(afterIdentity && afterIdentity.url || '') !== String(beforeIdentity && beforeIdentity.url || '')
      || String(afterIdentity && afterIdentity.documentId || '') !== String(beforeIdentity && beforeIdentity.documentId || '')
    )
  ) {
    return {
      ok: false,
      blocked: true,
      error: 'required_host_mismatch: screenshot document changed and was discarded',
    }
  }
  return { ok: true, screenshot: dataUrl }
}

function poisonDebuggerAndReload() {
  if (debuggerPoisoned) return
  debuggerPoisoned = true
  reloadPending = true
  stopPreviewCapture()
  // A preview can reload immediately. A page command defers reload until its
  // durable result receipt is acknowledged; either way no further CDP work is
  // admitted in this worker after poison.
  void applyPendingReloadIfQuiescent()
}

chrome.debugger?.onDetach?.addListener(async (source) => {
  const { cdpTabId } = await chrome.storage.local.get('cdpTabId')
  if (source && source.tabId === cdpTabId) await chrome.storage.local.remove('cdpTabId')
})

async function executeCommand(
  cmd,
  isCurrent = () => true,
  effectAuthority = { dispatchGeneration: 0, dispatchNonce: '', deadlineMs: Number.MAX_SAFE_INTEGER },
) {
  const effectCurrent = () => (
    isCurrent()
    && Number.isSafeInteger(effectAuthority.dispatchGeneration)
    && typeof effectAuthority.dispatchNonce === 'string'
    && Boolean(effectAuthority.dispatchNonce)
    && Number.isFinite(effectAuthority.deadlineMs)
    && Date.now() < effectAuthority.deadlineMs
  )
  const expired = () => ({
    ok: false,
    blocked: true,
    error: 'command_effect_expired: Pause, Unpair, or command deadline revoked this command',
  })
  const rendererArg = (arg = {}) => ({
    ...arg,
    __almaDispatchGeneration: effectAuthority.dispatchGeneration,
    __almaDispatchNonce: effectAuthority.dispatchNonce,
    __almaEffectDeadlineMs: effectAuthority.deadlineMs,
  })
  const showCommandOverlay = async (tabId, label) => {
    if (!effectCurrent()) return false
    await showOverlay(tabId, label, effectCurrent, effectAuthority)
    return effectCurrent()
  }
  const act = (tabId, func, arg, precondition) => actWithRetry(
    tabId,
    func,
    arg,
    precondition,
    effectCurrent,
    effectAuthority,
  )
  const action = String(cmd.action || '')
  if (!ALLOWED_ACTIONS.has(action)) return { ok: false, error: `unsupported action: ${action}` }
  if (action === 'ping') return { ok: true, data: { pong: true } }
  if (!effectCurrent()) return expired()

  const tab = await getAgentTab(true, effectCurrent)
  if (!tab || !tab.id) return { ok: false, error: 'could not open ALMA window' }
  if (!effectCurrent()) return expired()

  if (action === 'get_identity') {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!effectCurrent()) return expired()
    if (!current) return { ok: false, error: 'tab_identity_unavailable' }
    const url = String(current.url || '')
    if (!/^https?:\/\//i.test(url)) {
      return { ok: true, data: { url, documentId: null } }
    }
    const identity = await runInPage(tab.id, pageObservationIdentity)
    if (!effectCurrent()) return expired()
    return identity && identity.url
      ? { ok: true, data: { url: identity.url, documentId: identity.documentId || null } }
      : { ok: false, error: 'tab_identity_unavailable' }
  }

  const observationPrecondition = cmd.observationPrecondition || null
  if (observationPrecondition) {
    const refBoundAction = RECEIPT_REF_ACTIONS.has(action)
    const allowedRefs = Array.isArray(observationPrecondition.allowedRefs)
      ? observationPrecondition.allowedRefs.map(String)
      : []
    const refFingerprints = observationPrecondition.refFingerprints
      && typeof observationPrecondition.refFingerprints === 'object'
      ? observationPrecondition.refFingerprints
      : {}
    if (
      refBoundAction
      && (
        !observationPrecondition.domObservationId
        || !cmd.ref
        || !allowedRefs.includes(String(cmd.ref))
        || !refFingerprints[String(cmd.ref)]
      )
    ) {
      return {
        ok: false,
        blocked: true,
        error: 'observation_ref_failed: action ref/DOM generation was not present in the receipt-bound observation',
      }
    }
    const gate = await verifyObservationPrecondition(tab.id, observationPrecondition, refBoundAction)
    if (!effectCurrent()) return expired()
    if (!gate.ok) {
      await showCommandOverlay(tab.id, 'পেজ বদলে গেছে — আবার LOOK দরকার')
      if (!effectCurrent()) return expired()
      return gate
    }
  }

  if (action === 'wait') {
    const ms = Math.min(Math.max(Number(cmd.ms) || 1000, 0), 30000)
    await new Promise((r) => setTimeout(r, ms))
    return effectCurrent() ? { ok: true } : expired()
  }

  // Write verbs need the agent tab FOCUSED: since v0.8.0 it lives in the owner's
  // own window, and sites like Facebook close open dropdowns/menus the moment the
  // tab blurs — a click sequence spanning two commands (open dropdown → click
  // option) kept failing with element-not-found because the list vanished
  // between rounds. Fronting the tab for interactions mirrors a human session.
  if (WRITE_VERBS.has(action)) {
    try {
      if (!tab.active) {
        if (!effectCurrent()) return expired()
        await chrome.tabs.update(tab.id, { active: true })
        if (!effectCurrent()) return expired()
      }
    } catch { /* tab gone — the command itself will surface the error */ }
  }

  // READ-ONLY lockdown: refuse writes on a lockdown-tier site. Reading, scrolling,
  // screenshots and navigation stay allowed — lockdown means extraction-only.
  if (WRITE_VERBS.has(action)) {
    const locked = lockdownMatch(tab.url, cmd.lockdownDomains)
    if (locked) {
      await showCommandOverlay(tab.id, 'সাইটটা lockdown — শুধু পড়া যাবে')
      if (!effectCurrent()) return expired()
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
    if (cmd.bootstrapOnly === true && String(tab.url || '') !== 'about:blank') {
      return {
        ok: false,
        blocked: true,
        error: 'bootstrap_navigation_blocked: ALMA tab is not about:blank; LOOK first and use a receipt-bound ACT',
      }
    }
    const previousUrl = tab.url || ''
    if (observationPrecondition) {
      if (!effectCurrent()) return expired()
      const started = await runInPage(tab.id, pageNavigateAtomic, {
        ...rendererArg({
          targetUrl: cmd.url,
          expectedCurrentUrl: observationPrecondition.currentUrl,
          expectedDocumentId: observationPrecondition.documentId,
          domObservationId: observationPrecondition.domObservationId,
        }),
      })
      if (!effectCurrent()) return expired()
      if (!started || !started.ok) {
        return started || {
          ok: false,
          blocked: true,
          error: 'observation_document_changed: navigation precondition could not be revalidated',
        }
      }
    } else {
      if (!effectCurrent()) return expired()
      await chrome.tabs.update(tab.id, { url: cmd.url })
      if (!effectCurrent()) return expired()
    }
    // Front the ALMA tab (inside the owner's own window) so he SEES each page as
    // it loads — Claude-in-Chrome behaviour. Screenshots don't need this (CDP
    // captures background tabs); it's purely the "watch live" moment.
    try {
      if (!effectCurrent()) return expired()
      await chrome.tabs.update(tab.id, { active: true })
      if (!effectCurrent()) return expired()
    } catch {
      /* tab gone — next getAgentTab recreates */
    }
    await waitForTabLoad(tab.id, 15000, cmd.url, previousUrl)
    if (!effectCurrent()) return expired()
    const landed = await chrome.tabs.get(tab.id).catch(() => null)
    if (!effectCurrent()) return expired()
    if (!landed || !tabReachedNavigation(landed, cmd.url, previousUrl)) {
      return {
        ok: false,
        error: `navigation_not_committed: tab stayed at ${String(landed && landed.url || previousUrl || 'unknown')}`,
      }
    }
    await showCommandOverlay(tab.id, 'পেজ খুলছে: ' + cmd.url.replace(/^https?:\/\//, '').slice(0, 48))
    if (!effectCurrent()) return expired()
    return { ok: true, data: { url: cmd.url } }
  }
  if (action === 'go_back') {
    try {
      if (!effectCurrent()) return expired()
      await chrome.tabs.goBack(tab.id)
      if (!effectCurrent()) return expired()
    } catch {
      return { ok: false, error: 'no page to go back to' }
    }
    await waitForTabLoad(tab.id, 12000)
    if (!effectCurrent()) return expired()
    await showCommandOverlay(tab.id, 'পিছনে যাচ্ছে…')
    if (!effectCurrent()) return expired()
    return { ok: true, data: { back: true } }
  }
  if (action === 'screenshot') {
    return captureExactObservedScreenshot(tab, cmd, effectCurrent)
  }
  if (action === 'read_text') {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!effectCurrent()) return expired()
    if (!current || !/^https?:\/\//i.test(current.url || '')) {
      return { ok: false, error: `tab_not_readable: ${String(current && current.url || 'missing')}` }
    }
    await showCommandOverlay(tab.id, 'পেজ পড়ছে…')
    if (!effectCurrent()) return expired()
    const exactObservationRequired = Boolean(cmd && (
      Object.prototype.hasOwnProperty.call(cmd, 'expectedCurrentUrl')
      || Object.prototype.hasOwnProperty.call(cmd, 'expectedDocumentId')
    ))
    const readResult = await readPageTextWithPostSampleMute(
      tab.id,
      cmd.from,
      cmd.requireForeground === true,
      cmd.requiredHost,
      cmd.expectedCurrentUrl,
      cmd.expectedDocumentId,
      exactObservationRequired,
      effectCurrent,
    )
    return effectCurrent() ? readResult : expired()
  }
  if (action === 'read_dom') {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!effectCurrent()) return expired()
    if (!current || !/^https?:\/\//i.test(current.url || '')) {
      return { ok: false, error: `tab_not_readable: ${String(current && current.url || 'missing')}` }
    }
    await showCommandOverlay(tab.id, 'পেজ দেখছে…')
    if (!effectCurrent()) return expired()
    const expectedUrl = String(cmd.expectedCurrentUrl || '')
    const expectedDocumentId = String(cmd.expectedDocumentId || '')
    const exactObservationRequired = Boolean(cmd && (
      Object.prototype.hasOwnProperty.call(cmd, 'expectedCurrentUrl')
      || Object.prototype.hasOwnProperty.call(cmd, 'expectedDocumentId')
    ))
    if (exactObservationRequired && (!expectedUrl || !expectedDocumentId)) {
      return {
        ok: false,
        blocked: true,
        error: 'read_observation_precondition_missing: expected URL/document identity required',
      }
    }
    const data = await runInPage(tab.id, pageReadDom, rendererArg({
      requiredHost: cmd.requiredHost,
      ...(exactObservationRequired ? {
        expectedCurrentUrl: expectedUrl,
        expectedDocumentId,
      } : {}),
    }))
    if (!effectCurrent()) return expired()
    if (data && data.__almaEffectBlocked) return expired()
    if (data && data.__almaObservationBlocked) {
      return {
        ok: false,
        blocked: true,
        error: 'read_observation_precondition_failed: page changed; DOM was not returned',
      }
    }
    if (data && data.__almaHostBlocked) {
      return { ok: false, blocked: true, error: 'required_host_mismatch: page DOM was not read' }
    }
    if (
      exactObservationRequired
      && (
        !data
        || String(data.url || '') !== expectedUrl
        || String(data.documentId || '') !== expectedDocumentId
      )
    ) {
      return {
        ok: false,
        blocked: true,
        error: 'read_observation_precondition_failed: page changed; DOM was not returned',
      }
    }
    return { ok: true, data }
  }
  if (action === 'scroll') {
    await showCommandOverlay(tab.id, 'স্ক্রল করছে…')
    if (!effectCurrent()) return expired()
    return await act(tab.id, pageScroll, { by: cmd.by }, observationPrecondition)
  }
  if (action === 'click') {
    await showCommandOverlay(tab.id, 'ক্লিক করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    // actWithRetry: tolerate an element that renders a beat late + search iframes.
    return await act(
      tab.id,
      pageClick,
      { selector: cmd.selector, text: cmd.text, ref: cmd.ref },
      observationPrecondition,
    )
  }
  if (action === 'type') {
    await showCommandOverlay(tab.id, 'লিখছে: ' + String(cmd.value || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    const r = await act(tab.id, pageType, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      value: cmd.value,
      submit: Boolean(cmd.submit),
    }, observationPrecondition)
    if (!effectCurrent()) return expired()
    if (r && r.ok && cmd.submit) await waitForTabLoad(tab.id, 12000)
    return r
  }
  if (action === 'select_option') {
    await showCommandOverlay(tab.id, 'অপশন বাছছে: ' + String(cmd.option || cmd.value || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    return await act(tab.id, pageSelect, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      option: cmd.option,
      value: cmd.value,
    }, observationPrecondition)
  }
  if (action === 'pick_option') {
    await showCommandOverlay(tab.id, 'ড্রপডাউন থেকে বাছছে: ' + String(cmd.option || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    // Atomic open+choose — one injected script, so the menu can't blur-close
    // between the trigger click and the option click.
    return await act(tab.id, pagePickOption, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      option: cmd.option,
    }, observationPrecondition)
  }
  if (action === 'upload_file') {
    const src = String(cmd.url || '')
    if (!/^https:\/\//i.test(src) || /^(https:\/\/)(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(src)) {
      return { ok: false, error: 'upload_file needs a public https url' }
    }
    await showCommandOverlay(tab.id, 'ফাইল বসাচ্ছে: ' + (cmd.filename || src.split('/').pop() || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    let resp
    try {
      resp = await withTimeout(fetch(src), 20000, 'file download')
      if (!effectCurrent()) return expired()
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
    if (!effectCurrent()) return expired()
    if (buf.byteLength > 15 * 1024 * 1024) return { ok: false, error: 'file too large (>15MB)' }
    // ArrayBuffer → base64 (executeScript args must be JSON-serializable)
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    const b64 = btoa(bin)
    const fname = cmd.filename || decodeURIComponent((src.split('/').pop() || 'upload').split('?')[0]) || 'upload'
    return await act(tab.id, pageUploadFile, {
      selector: cmd.selector,
      text: cmd.text,
      ref: cmd.ref,
      b64,
      filename: fname,
      mime,
    }, observationPrecondition)
  }
  if (action === 'hover') {
    await showCommandOverlay(tab.id, 'হোভার করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    return await act(
      tab.id,
      pageHover,
      { selector: cmd.selector, text: cmd.text, ref: cmd.ref },
      observationPrecondition,
    )
  }
  if (action === 'scroll_to') {
    await showCommandOverlay(tab.id, 'স্ক্রল করছে: ' + String(cmd.text || cmd.selector || '').slice(0, 40))
    if (!effectCurrent()) return expired()
    return await act(
      tab.id,
      pageScrollTo,
      { selector: cmd.selector, text: cmd.text, ref: cmd.ref },
      observationPrecondition,
    )
  }
  if (action === 'switch_tab') {
    const picked = await pickFollowTab(tab)
    if (!effectCurrent()) return expired()
    if (!picked) return { ok: false, error: 'no other tab to switch to' }
    try {
      if (!effectCurrent()) return expired()
      await chrome.tabs.update(picked.id, { active: true })
      if (!effectCurrent()) return expired()
    } catch {
      return { ok: false, error: 'could not switch tab' }
    }
    // setAgentTab also pulls the followed tab into the ALMA tab group.
    await setAgentTab(picked.id, picked.windowId, effectCurrent)
    if (!effectCurrent()) return expired()
    await waitForTabLoad(picked.id, 12000)
    if (!effectCurrent()) return expired()
    await showCommandOverlay(picked.id, 'নতুন ট্যাবে গেছে')
    if (!effectCurrent()) return expired()
    return { ok: true, data: { url: picked.url || '', title: picked.title || '' } }
  }
  if (action === 'close_tab') {
    // Close the newest extra tab (e.g. a popup) and fall back to the agent tab.
    const extra = await pickFollowTab(tab)
    if (!effectCurrent()) return expired()
    if (!extra) return { ok: false, error: 'no extra tab to close' }
    try {
      if (!effectCurrent()) return expired()
      await chrome.tabs.remove(extra.id)
      if (!effectCurrent()) return expired()
    } catch {
      return { ok: false, error: 'could not close tab' }
    }
    await setAgentTab(tab.id, tab.windowId, effectCurrent)
    if (!effectCurrent()) return expired()
    try {
      if (!effectCurrent()) return expired()
      await chrome.tabs.update(tab.id, { active: true })
      if (!effectCurrent()) return expired()
    } catch {
      /* ignore */
    }
    return { ok: true, data: { closed: extra.url || extra.id } }
  }
  if (action === 'press') {
    await showCommandOverlay(tab.id, 'কী চাপছে: ' + String(cmd.key || 'Enter').slice(0, 20))
    if (!effectCurrent()) return expired()
    const r = await act(tab.id, pageKey, { key: cmd.key }, observationPrecondition)
    if (!effectCurrent()) return expired()
    // Enter often triggers navigation/submit — give the page a moment to settle.
    if (r && r.ok && String(cmd.key || 'Enter') === 'Enter') await waitForTabLoad(tab.id, 12000)
    return r
  }
  return { ok: false, error: 'unhandled action' }
}

// ---- poll loop --------------------------------------------------------------

function validPendingResult(value) {
  return Boolean(value
    && typeof value === 'object'
    && typeof value.baseUrl === 'string'
    && value.payload
    && typeof value.payload === 'object'
    && typeof value.payload.commandId === 'string'
    && value.payload.commandId)
}

async function clearPendingResult(commandId) {
  const stored = await chrome.storage.local.get(PENDING_RESULT_KEY)
  const current = stored[PENDING_RESULT_KEY]
  // A late response from A must never erase a newer persisted B.
  if (current?.payload?.commandId === commandId) {
    await chrome.storage.local.remove(PENDING_RESULT_KEY)
  }
}

async function flushPendingResult(base, token) {
  try {
    const stored = await chrome.storage.local.get(PENDING_RESULT_KEY)
    const pending = stored[PENDING_RESULT_KEY]
    if (pending == null) return true
    if (!validPendingResult(pending)) {
      await chrome.storage.local.remove(PENDING_RESULT_KEY)
      return true
    }
    const targetBase = pending.baseUrl || base
    const response = await fetch(`${targetBase}${RESULT_PATH}`, {
      method: 'POST',
      // Our own device token is the credential — say so, so no browser cookie is
      // ever quietly along for the ride. It used to be, and when Chrome stopped
      // sending it these calls started failing for a reason that had nothing to
      // do with whether the token was valid.
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(pending.payload),
    })
    // 2xx includes the idempotent `{ ignored: true }` response. A 404 means
    // the bounded server command expired/was removed, so retrying forever
    // cannot improve truth and would permanently stop this companion.
    if (response.ok || response.status === 404) {
      await clearPendingResult(pending.payload.commandId)
      return true
    }
    if (response.status === 401) {
      await clearPendingResult(pending.payload.commandId)
      stopPreviewCapture()
      await chrome.storage.local.set({ token: '', lastError: 'result rejected (401)' })
      return false
    }
    await chrome.storage.local.set({ lastError: `result delivery failed (${response.status})` })
    return false
  } catch (err) {
    console.warn('[alma-companion] postResult failed:', err && err.message)
    await chrome.storage.local.set({
      lastError: `result delivery failed: ${err && err.message ? err.message : String(err)}`,
    }).catch(() => {})
    return false
  }
}

async function postResult(base, token, commandId, result) {
  try {
    const tab = await getAgentTab(false)
    const contextId = tab?.id ? `tab:${tab.id}` : null
    const pending = {
      baseUrl: base,
      savedAt: Date.now(),
      payload: { commandId, ...result, contextId },
    }
    // Persist BEFORE the first delivery attempt. If Chrome suspends this MV3
    // worker after the page effect, the next wake flushes this receipt first.
    await chrome.storage.local.set({ [PENDING_RESULT_KEY]: pending })
    return await flushPendingResult(base, token)
  } catch (err) {
    console.warn('[alma-companion] could not persist command result:', err && err.message)
    return false
  }
}

async function applyPendingReloadIfQuiescent() {
  if (!reloadPending || commandInFlight) return false
  const stored = await chrome.storage.local.get(PENDING_RESULT_KEY)
  if (commandInFlight || stored[PENDING_RESULT_KEY] != null) return false
  chrome.runtime.reload()
  return true
}

function stopPreviewCapture() {
  previewGrant = null
  if (previewTimer) clearInterval(previewTimer)
  previewTimer = null
  // Invalidate old side effects immediately, but keep its single-flight gate
  // until the bounded tick unwinds. A replacement must never overlap old CDP
  // detach/re-attach cleanup on the same tab.
  resetPreviewCaptureState(previewCaptureState)
}

function previewAttemptCurrent(generation, grant) {
  return previewAttemptMayMutate(previewCaptureState, generation, previewGrant, grant)
}

async function getPreviewAgentTab(generation, grant) {
  const isCurrent = () => previewAttemptCurrent(generation, grant)
  const stored = await withPreviewDeadline(
    chrome.storage.local.get('agentTabId'),
    PREVIEW_TAB_LOOKUP_TIMEOUT_MS,
    'preview tab state lookup',
  )
  if (!isCurrent() || !stored.agentTabId) return null
  const tab = await withPreviewDeadline(
    chrome.tabs.get(stored.agentTabId),
    PREVIEW_TAB_LOOKUP_TIMEOUT_MS,
    'preview tab lookup',
  ).catch(() => null)
  return isCurrent() ? tab : null
}

async function performPreviewCapture(grant, generation) {
  const tab = await getPreviewAgentTab(generation, grant)
  if (!tab?.id || !previewAttemptCurrent(generation, grant)) return
  // Do not race the whole CDP operation with a shorter outer timer. Each stage
  // is bounded, and cdpOperationQueue retains the real capture+cleanup promise
  // until it settles, so a replacement can never overlap an abandoned call.
  const dataUri = await captureAgentTab(
    tab,
    52,
    PREVIEW_CAPTURE_CALL_TIMEOUT_MS,
    () => previewAttemptCurrent(generation, grant),
    false,
  )
  if (!dataUri || !previewAttemptCurrent(generation, grant)) return
  const capturedMs = Math.max(Date.now(), lastPreviewCaptureMs + 1)
  const response = await fetchPreviewWithDeadline(
    fetch,
    `${grant.base}${FRAME_PATH}`,
    {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({
        contextId: `tab:${tab.id}`,
        turnId: grant.turnId,
        conversationId: grant.conversationId,
        capturedAt: new Date(capturedMs).toISOString(),
        dataUri,
      }),
    },
    PREVIEW_UPLOAD_TIMEOUT_MS,
  )
  // A stopped/timed-out A must never apply a late ACK/409 to replacement B,
  // even if both activities happen to use the same device and tab.
  if (!previewAttemptCurrent(generation, grant)) return
  if (response.ok) {
    lastPreviewCaptureMs = capturedMs
    // iOS renews the server lease while this extension may be inside a long
    // command (and unable to poll). The frame ACK bridges that renewal so the
    // local capture timer does not stop at its original expiry.
    const ack = await withPreviewDeadline(
      response.json(),
      PREVIEW_ACK_TIMEOUT_MS,
      'Browser preview acknowledgement',
    ).catch(() => ({}))
    if (!previewAttemptCurrent(generation, grant)) return
    const current = previewGrant
    const renewedExpiry = typeof ack?.leaseExpiresAt === 'string'
      ? Date.parse(ack.leaseExpiresAt) : NaN
    if (Number.isFinite(renewedExpiry) && renewedExpiry > Date.parse(current.expiresAt)) {
      previewGrant = { ...current, expiresAt: ack.leaseExpiresAt }
    }
  } else if (response.status === 401 || response.status === 409) {
    stopPreviewCapture()
    if (response.status === 401) {
      await chrome.storage.local.set({ token: '', lastError: 'preview rejected (401)' })
    }
  }
}

async function capturePreviewFrame() {
  const grant = previewGrant
  if (!grant || Date.parse(grant.expiresAt) <= Date.now()) {
    if (grant && Date.parse(grant.expiresAt) <= Date.now()) stopPreviewCapture()
    return
  }
  // Explicit ~1fps bound even if a timer/poll wake happens at the same instant.
  if (Date.now() - lastPreviewCaptureMs < 850) return
  try {
    await runPreviewCaptureExclusive(
      previewCaptureState,
      (generation) => performPreviewCapture(grant, generation),
    )
  } catch (err) {
    console.warn('[alma-companion] preview frame failed:', err && err.message)
  }
}

function applyPreviewGrant(raw, base, token) {
  if (!raw?.active || typeof raw.expiresAt !== 'string' || Date.parse(raw.expiresAt) <= Date.now()) {
    stopPreviewCapture()
    return
  }
  previewGrant = { ...raw, base, token }
  if (!previewTimer) previewTimer = setInterval(() => { void capturePreviewFrame() }, 1000)
  // First pixels should arrive with the first poll, not one timer beat later.
  void capturePreviewFrame()
}

async function commandDispatchPaused() {
  try {
    const state = await chrome.storage.local.get('paused')
    return Boolean(state.paused)
  } catch {
    // Losing the local kill-switch state must never become permission to act.
    return true
  }
}

async function commandDispatchTokenMatches(expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) return false
  try {
    const state = await chrome.storage.local.get('token')
    return typeof state.token === 'string' && state.token === expectedToken
  } catch {
    // Storage failure cannot preserve the exact pairing authority captured by
    // the poll, so it must revoke this dispatch instead of permitting an act.
    return false
  }
}

// A Promise.race timeout does not cancel the losing async branch. Pause/Unpair
// therefore revoke a monotonically increasing local generation synchronously;
// every command captures one generation and all later continuations compare it
// again before they may reach a browser/page mutation.
let commandDispatchGeneration = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1)) + 1
let activeCommandDispatchNonce = ''

function persistCommandDispatchRevocation() {
  try {
    return Promise.resolve(chrome.storage.local.set({
      commandDispatchGeneration,
      commandDispatchNonce: '',
    })).then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

function revokeCommandDispatchAuthority() {
  commandDispatchGeneration = (commandDispatchGeneration % (Number.MAX_SAFE_INTEGER - 1)) + 1
  activeCommandDispatchNonce = ''
  // The in-memory bump is synchronous. The durable marker is what a renderer
  // task queued inside Chrome can observe after this worker has already moved
  // on (or restarted).
  return persistCommandDispatchRevocation()
}

function createCommandDispatchNonce() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch { /* fallback below */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

async function dispatchAuthorizedPolledCommand(baseUrl, token, cmd, isCurrent = () => true) {
  const commandId = String(cmd && cmd.id || '')
  const capturedGeneration = commandDispatchGeneration
  const dispatchStillCurrent = () => (
    isCurrent()
    && commandDispatchGeneration === capturedGeneration
  )
  if (!commandId) {
    return {
      ok: false,
      blocked: true,
      error: 'command_authorization_failed: polled command id is missing',
    }
  }

  // The long-poll captures one exact pairing authority. Unpair/re-pair may
  // replace it while the poll is outstanding; never authorize under a token
  // the owner's current local state has already revoked.
  if (!(await commandDispatchTokenMatches(token))) {
    stopPreviewCapture()
    return {
      ok: false,
      blocked: true,
      error: 'command_dispatch_unpaired: pairing token changed before authorization',
    }
  }

  // Re-read the local kill switch at the last boundary before asking the
  // server. The poll may have started while active and returned after the owner
  // pressed Pause.
  if (await commandDispatchPaused()) {
    stopPreviewCapture()
    return {
      ok: false,
      blocked: true,
      error: 'command_dispatch_paused: owner paused Companion before authorization',
    }
  }

  let exchange
  try {
    exchange = await withTimeout(
      fetch(`${baseUrl}${AUTHORIZE_PATH}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ commandId }),
      }).then(async (response) => ({
        response,
        body: await response.json().catch(() => ({})),
      })),
      COMMAND_AUTHORIZATION_TIMEOUT_MS,
      'command authorization',
    )
  } catch (err) {
    return {
      ok: false,
      blocked: true,
      error: `command_authorization_failed: ${String(err && err.message || err || 'network error').slice(0, 180)}`,
    }
  }

  if (!exchange || !exchange.response) {
    return {
      ok: false,
      blocked: true,
      error: `command_authorization_failed: ${String(exchange && exchange.error || 'authorization response unavailable').slice(0, 180)}`,
    }
  }
  const response = exchange.response
  const body = exchange.body || {}
  if (!response.ok || body.authorized !== true) {
    const detail = String(body.error || body.reason || `HTTP ${response.status || 'denied'}`).slice(0, 180)
    return {
      ok: false,
      blocked: true,
      error: `command_authorization_denied: ${detail}`,
    }
  }

  // Authorization is a permission check, not a lease over the local kill
  // switch. Pause may land while the POST is in flight, so re-check it at the
  // exact boundary before the first possible page effect.
  if (await commandDispatchPaused()) {
    stopPreviewCapture()
    return {
      ok: false,
      blocked: true,
      error: 'command_dispatch_paused: owner paused Companion before execution',
    }
  }
  // Authorization is bound to the captured device token, but Unpair is local
  // and can land while that POST is in flight. Make the current stored token
  // the final asynchronous authority sample immediately before any page work.
  if (!(await commandDispatchTokenMatches(token))) {
    stopPreviewCapture()
    return {
      ok: false,
      blocked: true,
      error: 'command_dispatch_unpaired: pairing token changed before execution',
    }
  }
  if (!dispatchStillCurrent()) {
    return {
      ok: false,
      blocked: true,
      error: 'command_authorization_expired: command dispatch is no longer current',
    }
  }

  // A random per-command nonce avoids generation collision across MV3 worker
  // restarts. Renderer tasks compare this exact durable lease after they begin,
  // so an old executeScript queued by Chrome cannot inherit a new command's
  // authority merely because an in-memory counter reset.
  const dispatchNonce = createCommandDispatchNonce()
  activeCommandDispatchNonce = dispatchNonce
  try {
    await chrome.storage.local.set({
      commandDispatchGeneration: capturedGeneration,
      commandDispatchNonce: dispatchNonce,
    })
  } catch {
    activeCommandDispatchNonce = ''
    return {
      ok: false,
      blocked: true,
      error: 'command_authorization_failed: renderer authority could not be persisted',
    }
  }
  if (!dispatchStillCurrent() || activeCommandDispatchNonce !== dispatchNonce) {
    return {
      ok: false,
      blocked: true,
      error: 'command_authorization_expired: command dispatch was revoked before execution',
    }
  }

  // The deadline is also carried into every renderer mutation. Promise.race
  // cannot cancel an executeScript call that Chrome queued but starts later;
  // the injected function must be inert once this absolute clock has elapsed.
  const effectAuthority = {
    dispatchGeneration: capturedGeneration,
    dispatchNonce,
    deadlineMs: Date.now() + COMMAND_EXECUTION_TIMEOUT_MS,
  }
  const effectStillCurrent = () => (
    dispatchStillCurrent()
    && activeCommandDispatchNonce === dispatchNonce
    && Date.now() < effectAuthority.deadlineMs
  )
  const result = await withTimeout(
    executeCommand(cmd, effectStillCurrent, effectAuthority),
    COMMAND_EXECUTION_TIMEOUT_MS,
    cmd.action || 'command',
  )
  if (activeCommandDispatchNonce === dispatchNonce) {
    activeCommandDispatchNonce = ''
    try {
      await chrome.storage.local.set({ commandDispatchNonce: '' })
    } catch {
      // Deadline + random nonce still keep the abandoned renderer inert. A
      // storage failure cannot be treated as permission for another command.
    }
  }
  return result
}

async function pollOnce() {
  const { baseUrl, token, paused } = await getConfig()
  if (!token || paused) {
    stopPreviewCapture()
    return 'stop'
  }
  // Never reclaim/execute another command while the previous page effect has
  // an unacknowledged durable receipt. This closes click/type duplication when
  // a result response is lost and the server later reclaims the delivery.
  if (!(await flushPendingResult(baseUrl, token))) return 'retry'
  if (reloadPending) {
    await applyPendingReloadIfQuiescent()
    return 'stop'
  }
  let cmd = null
  let pausedAfterPoll = false
  try {
    const res = await fetch(`${baseUrl}${POLL_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit', // the device token is the credential — never a cookie
      headers: {
        Authorization: `Bearer ${token}`,
        'X-ALMA-Companion-Protocol': COMPANION_PROTOCOL,
      },
    })
    if (res.status === 401) {
      stopPreviewCapture()
      await chrome.storage.local.set({ token: '', lastError: 'pairing rejected (401)' })
      return 'stop'
    }
    if (!res.ok) {
      await chrome.storage.local.set({ lastError: `server heartbeat failed (${res.status})` })
      return 'retry'
    }
    // The long-poll may have been outstanding when the owner pressed Pause.
    // Check before interpreting a delivered command or starting its preview.
    pausedAfterPoll = await commandDispatchPaused()
    if (pausedAfterPoll) stopPreviewCapture()
    await chrome.storage.local.set({ lastSuccessfulPollAt: Date.now(), lastError: '' })
    const body = await res.json().catch(() => ({}))
    // Pause can also land while the response body is being read. This second
    // local check is the immediate pre-dispatch fence; the dispatcher checks
    // once more after server authorization and before the effect.
    pausedAfterPoll = pausedAfterPoll || await commandDispatchPaused()
    if (pausedAfterPoll) stopPreviewCapture()
    else applyPreviewGrant(body?.preview, baseUrl, token)
    cmd = body && body.command ? body.command : null
  } catch (err) {
    await chrome.storage.local.set({
      lastError: `server heartbeat failed: ${err && err.message ? err.message : String(err)}`,
    })
    return 'retry'
  }
  if (!cmd) {
    if (pausedAfterPoll) return 'stop'
    if (reloadPending) {
      await applyPendingReloadIfQuiescent()
      return 'stop'
    }
    return 'connected' // connected, just idle
  }
  commandInFlight = true
  try {
    await setBadge(pausedAfterPoll ? 'off' : 'run')
    let result
    const execution = { active: true }
    try {
      result = pausedAfterPoll
        ? {
            ok: false,
            blocked: true,
            error: 'command_dispatch_paused: owner paused Companion after poll delivery',
          }
        : await dispatchAuthorizedPolledCommand(
            baseUrl,
            token,
            cmd,
            () => execution.active,
          )
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) }
    } finally {
      // If the whole command deadline won, a queued/late screenshot may still
      // finish cleanup but must not start capture fallback or return pixels.
      execution.active = false
    }
    const delivered = await postResult(baseUrl, token, cmd.id, result)
    if (!delivered) return 'retry'
    await setBadge(pausedAfterPoll ? 'off' : 'on')
    return pausedAfterPoll ? 'stop' : 'connected'
  } finally {
    commandInFlight = false
    if (reloadPending) await applyPendingReloadIfQuiescent()
  }
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
    stopPreviewCapture()
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
      reloadPending = true
      await applyPendingReloadIfQuiescent()
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

function localMessageRevokesPreview(msg) {
  return msg?.type === 'unpair' || (msg?.type === 'setPaused' && Boolean(msg.paused))
}

function handleLocalStorageAuthorityChange(changes) {
  const authorityRevoked = (
    changes?.paused?.newValue === true
    || Boolean(changes?.token)
  )
  if (authorityRevoked) {
    void revokeCommandDispatchAuthority()
    stopPreviewCapture()
  }
  if (changes.token || changes.paused) loop()
}

chrome.storage.onChanged.addListener(handleLocalStorageAuthorityChange)

async function unpairFromServer() {
  // Direct callers (including recovery/test paths) must revoke before the first
  // await; the popup listener also does this synchronously as defense in depth.
  const revocationPersistence = revokeCommandDispatchAuthority()
  // Pause is local and immediate. Keep the token until the server confirms its
  // hash is revoked; clearing it first would make a failed/networked revocation
  // impossible to retry from this browser while another token copy stayed live.
  await chrome.storage.local.set({
    paused: true,
    commandDispatchGeneration,
    commandDispatchNonce: '',
  })
  await revocationPersistence
  const { baseUrl, token } = await getConfig()
  await setBadge('off')
  if (!token) {
    await chrome.storage.local.remove(PENDING_RESULT_KEY)
    await chrome.storage.local.set({ token: '', lastError: '' })
    return { ok: true, revoked: true }
  }

  try {
    const exchange = await withTimeout(
      fetch(`${baseUrl}${UNPAIR_PATH}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
      }).then(async (response) => ({
        response,
        body: await response.json().catch(() => ({})),
      })),
      COMMAND_AUTHORIZATION_TIMEOUT_MS,
      'device unpair',
    )
    const body = exchange?.body || {}
    if (exchange?.response?.status === 202 && body.stopping === true) {
      const error = 'Unpair অপেক্ষায়—ইতিমধ্যে অনুমোদিত browser step শেষ হলে আবার Unpair চাপুন।'
      await chrome.storage.local.set({ lastError: error })
      return { ok: false, stopping: true, error }
    }
    if (!exchange?.response?.ok || body.ok !== true || body.revoked !== true) {
      const error = `Server-side Unpair নিশ্চিত হয়নি: ${String(body.error || `HTTP ${exchange?.response?.status || 'unavailable'}`).slice(0, 140)}`
      await chrome.storage.local.set({ lastError: error })
      return { ok: false, error }
    }
    await chrome.storage.local.remove(PENDING_RESULT_KEY)
    await chrome.storage.local.set({ token: '', paused: true, lastError: '' })
    return { ok: true, revoked: true }
  } catch (err) {
    const error = `Server-side Unpair নিশ্চিত হয়নি: ${String(err?.message || err || 'network error').slice(0, 140)}`
    await chrome.storage.local.set({ lastError: error })
    return { ok: false, error }
  }
}

// If the owner closes the ALMA tab, forget it (and its debugger attachment) so
// the next command opens a fresh grouped tab.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { agentTabId, cdpTabId } = await chrome.storage.local.get(['agentTabId', 'cdpTabId'])
  if (agentTabId === tabId) await chrome.storage.local.remove(['agentTabId', 'agentWindowId'])
  if (cdpTabId === tabId) await chrome.storage.local.remove('cdpTabId')
})

// Popup ↔ background messaging (pairing / status / kill switch).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Acknowledge Pause/Unpair only after capture has stopped locally. Waiting
  // for the existing poll loop is unsafe: it may still own a 1fps timer and an
  // old bearer-backed preview grant while `looping` makes the restart a no-op.
  let revocationPersistence = Promise.resolve(true)
  if (localMessageRevokesPreview(msg)) {
    revocationPersistence = revokeCommandDispatchAuthority()
    stopPreviewCapture()
  }
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
      const paused = Boolean(msg.paused)
      await chrome.storage.local.set(paused
        ? {
            paused: true,
            commandDispatchGeneration,
            commandDispatchNonce: '',
          }
        : { paused: false })
      if (paused) await revocationPersistence
      await setBadge(msg.paused ? 'off' : 'on')
      sendResponse({ ok: true })
    } else if (msg.type === 'unpair') {
      sendResponse(await unpairFromServer())
    }
  })()
  return true // async response
})

async function pairWithCode(code, baseUrlIn, deviceName) {
  const base = (baseUrlIn || DEFAULT_BASE).replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/assistant/live-browser/pair`, {
      method: 'POST',
      credentials: 'omit', // the one-time code is the credential — never a cookie
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim(), deviceName: deviceName || 'My Chrome' }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) return { ok: false, error: body.error || `pairing failed (${res.status})` }
    // A receipt belongs to the old device token. Never replay page data into a
    // newly paired owner's command namespace.
    const revocationPersistence = revokeCommandDispatchAuthority()
    await chrome.storage.local.remove(PENDING_RESULT_KEY)
    await chrome.storage.local.set({
      token: body.token,
      baseUrl: base,
      paused: false,
      commandDispatchGeneration,
      commandDispatchNonce: '',
      deviceName: deviceName || 'My Chrome',
      lastSuccessfulPollAt: Date.now(),
      lastError: '',
    })
    await revocationPersistence
    await setBadge('on')
    loop()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}
