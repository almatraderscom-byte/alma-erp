/**
 * Live browser session on the VPS — a Chromium the owner can WATCH and TAKE OVER.
 *
 * The existing browser worker is blind by design: it takes a list of steps, runs
 * them headless, and hands back a screenshot. That is fine until the page asks for
 * a login or throws a captcha, at which point the task is simply dead — there is
 * nobody at the keyboard. This module is the answer to that: the same VPS
 * Chromium, but streaming frames out and accepting clicks and keystrokes back, so
 * the owner can step in for the ten seconds that need a human and let the agent
 * finish the rest.
 *
 * Transport is deliberately boring — CDP screencast frames over SSE, input over
 * POST. Not a WebSocket, because the owner's browser talks to an HTTPS app and
 * this service listens on plain HTTP: the frames have to be relayed through the
 * app either way, and a one-way event stream plus a plain POST relays cleanly,
 * while a socket does not. When a TLS endpoint exists in front of this service the
 * same two routes work directly, with no protocol change.
 *
 * ── The audio rule this module must not break ────────────────────────────────
 *
 * This VPS also runs the SIP gateway, and the call audio tuning is frozen by
 * project rule: cushion ≤ 16 frames, underruns ≤ 1. Chromium already runs on this
 * box, but only in short headless bursts. A live session is a different animal —
 * it stays open for minutes and encodes JPEG continuously — so it is fenced:
 *
 *   • one live session at a time, ever;
 *   • it will not START while a call is in progress, and it PAUSES itself when a
 *     call arrives mid-session (frames stop; the page keeps its state);
 *   • ~5 fps at quality 50, because the encode is the CPU cost, not the browsing;
 *   • it pauses on idle and dies on an absolute deadline, so a forgotten tab
 *     cannot sit there burning cycles next to a live call.
 *
 * None of this touches the playout or the VAD. It keeps load away from them.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.BROWSER_LIVE_PORT ?? 8781)
const BIND = process.env.BROWSER_LIVE_BIND ?? '0.0.0.0'
/** Shared with the app; the same token the internal job endpoints use. */
const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
/** SIP gateway control API, used only to ask whether a call is up right now. */
const SIP_BASE = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')

const FRAME_INTERVAL_MS = 200 // ~5 fps ceiling while the page is actually moving
/**
 * Floor for a page that is NOT moving. CDP only emits a screencast frame when
 * something repaints, so a finished, static page produces nothing at all — a
 * viewer who connects at that moment would sit staring at an empty panel. This
 * interval is how often we capture one ourselves to keep the picture true.
 */
const STATIC_CAPTURE_MS = 1000
const JPEG_QUALITY = 50
const VIEWPORT = { width: 1280, height: 800 }
const IDLE_PAUSE_MS = 60_000
const ABSOLUTE_MAX_MS = 20 * 60_000
const CALL_CHECK_INTERVAL_MS = 5_000

/** The single live session, or null. One at a time is a hard rule, not a default. */
let session = null

function log(...args) {
  console.log('[browser-live]', ...args)
}

function authOk(req) {
  const header = req.headers.authorization ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!TOKEN || !provided) return false
  const a = Buffer.from(TOKEN, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Is a call up right now? Fails CLOSED — if the gateway cannot be reached we
 * assume a call is in progress, because the cost of guessing wrong in the other
 * direction is degraded audio on a live customer call.
 */
async function callInProgress() {
  if (!SIP_BASE) return false // no gateway configured on this host ⇒ nothing to protect
  try {
    const res = await fetch(`${SIP_BASE}/api/v1/active`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return true
    const body = await res.json().catch(() => null)
    const calls = body?.calls ?? body?.active ?? []
    return Array.isArray(calls) ? calls.length > 0 : Boolean(calls)
  } catch {
    return true // fail closed
  }
}

// ─── session lifecycle ───────────────────────────────────────────────────────

async function startSession({ startUrl, goal }) {
  if (session) return { ok: false, error: 'a live session is already running' }
  if (await callInProgress()) {
    return { ok: false, error: 'a call is in progress — live browsing is paused so the call audio stays clean' }
  }

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return { ok: false, error: 'playwright_not_installed' }
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)

  const id = `live_${Date.now().toString(36)}`
  session = {
    id,
    goal: String(goal ?? ''),
    browser,
    context,
    page,
    cdp,
    clients: new Set(),
    lastFrameSentAt: 0,
    /** Most recent JPEG (base64). Sent to a viewer the moment it connects, so
     *  arriving at a finished page shows the page rather than nothing. */
    lastFrame: null,
    lastActivityAt: Date.now(),
    startedAt: Date.now(),
    paused: false,
    pauseReason: null,
    timers: [],
  }

  // Frames: throttled to FRAME_INTERVAL_MS. Every frame is ACKed even when it is
  // dropped — Chromium stops sending until the previous one is acknowledged.
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    if (!session || session.paused) return
    const now = Date.now()
    if (now - session.lastFrameSentAt < FRAME_INTERVAL_MS) return
    session.lastFrameSentAt = now
    session.lastFrame = data
    broadcast('frame', { data })
  })

  // Static-page floor. Only runs while someone is actually watching — an
  // unwatched session must not spend CPU next to a live call for nobody.
  session.timers.push(
    setInterval(async () => {
      if (!session || session.paused || session.clients.size === 0) return
      if (Date.now() - session.lastFrameSentAt < STATIC_CAPTURE_MS) return
      try {
        const buf = await session.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY })
        session.lastFrameSentAt = Date.now()
        session.lastFrame = buf.toString('base64')
        broadcast('frame', { data: session.lastFrame })
      } catch {
        /* mid-navigation screenshots can fail; the next tick covers it */
      }
    }, STATIC_CAPTURE_MS),
  )

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: JPEG_QUALITY,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  })

  if (startUrl) {
    await page.goto(startUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' }).catch((err) => {
      log(`initial goto failed: ${err?.message ?? err}`)
    })
  }

  // A call that starts mid-session pauses it. The page keeps its state, so the
  // owner resumes exactly where he was once the call ends.
  session.timers.push(
    setInterval(async () => {
      if (!session) return
      const busy = await callInProgress()
      if (busy && !session.paused) {
        pause('a call is in progress')
      } else if (!busy && session.paused && session.pauseReason === 'a call is in progress') {
        resume()
      }
    }, CALL_CHECK_INTERVAL_MS),
  )

  // Idle pause + absolute deadline.
  session.timers.push(
    setInterval(() => {
      if (!session) return
      if (Date.now() - session.startedAt > ABSOLUTE_MAX_MS) {
        log('absolute deadline reached — closing')
        void stopSession('absolute deadline reached')
        return
      }
      if (!session.paused && Date.now() - session.lastActivityAt > IDLE_PAUSE_MS) {
        pause('idle')
      }
    }, 5_000),
  )

  log(`session ${id} started${startUrl ? ` at ${startUrl}` : ''}`)
  return { ok: true, sessionId: id, viewport: VIEWPORT }
}

function pause(reason) {
  if (!session || session.paused) return
  session.paused = true
  session.pauseReason = reason
  session.cdp.send('Page.stopScreencast').catch(() => {})
  broadcast('paused', { reason })
  log(`paused — ${reason}`)
}

function resume() {
  if (!session || !session.paused) return
  session.paused = false
  session.pauseReason = null
  session.lastActivityAt = Date.now()
  session.cdp
    .send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    })
    .catch(() => {})
  broadcast('resumed', {})
  log('resumed')
}

async function stopSession(reason) {
  if (!session) return { ok: true }
  const current = session
  session = null
  broadcastTo(current, 'ended', { reason: reason ?? 'closed' })
  for (const timer of current.timers) clearInterval(timer)
  for (const client of current.clients) {
    try {
      client.end()
    } catch {
      /* client already gone */
    }
  }
  await current.browser.close().catch(() => {})
  log(`session ${current.id} closed — ${reason ?? 'closed'}`)
  return { ok: true }
}

function broadcast(event, payload) {
  if (session) broadcastTo(session, event, payload)
}

function broadcastTo(target, event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of target.clients) {
    try {
      client.write(chunk)
    } catch {
      target.clients.delete(client)
    }
  }
}

// ─── owner input ─────────────────────────────────────────────────────────────

/**
 * Apply one owner input event to the page. Coordinates are in the streamed
 * viewport's own space, so what he clicks is what the page gets.
 */
async function applyInput(event) {
  if (!session) return { ok: false, error: 'no live session' }
  if (session.paused) resume()
  session.lastActivityAt = Date.now()

  const { cdp, page } = session
  const x = Number(event.x)
  const y = Number(event.y)

  switch (String(event.type)) {
    case 'click': {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'click needs x and y' }
      const base = { x, y, button: 'left', clickCount: 1 }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
      return { ok: true }
    }
    case 'move': {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'move needs x and y' }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      return { ok: true }
    }
    case 'scroll': {
      const deltaY = Number(event.deltaY ?? 0)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Number.isFinite(x) ? x : VIEWPORT.width / 2,
        y: Number.isFinite(y) ? y : VIEWPORT.height / 2,
        deltaX: 0,
        deltaY,
      })
      return { ok: true }
    }
    case 'text': {
      const text = String(event.text ?? '')
      if (!text) return { ok: false, error: 'text is empty' }
      await page.keyboard.type(text, { delay: 10 })
      return { ok: true }
    }
    case 'key': {
      const key = String(event.key ?? '')
      if (!key) return { ok: false, error: 'key is empty' }
      await page.keyboard.press(key)
      return { ok: true }
    }
    case 'navigate': {
      const url = String(event.url ?? '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'navigate needs an http(s) url' }
      await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' })
      return { ok: true }
    }
    default:
      return { ok: false, error: `unknown input type: ${event.type}` }
  }
}

function status() {
  if (!session) return { running: false }
  return {
    running: true,
    sessionId: session.id,
    goal: session.goal,
    paused: session.paused,
    pauseReason: session.pauseReason,
    viewers: session.clients.size,
    startedAt: new Date(session.startedAt).toISOString(),
    url: session.page.url(),
  }
}

// ─── HTTP surface ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/health') return json(res, 200, { ok: true, ...status() })
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' })

  try {
    if (url.pathname === '/live/status' && req.method === 'GET') {
      return json(res, 200, status())
    }

    if (url.pathname === '/live/start' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await startSession(body)
      return json(res, result.ok ? 200 : 409, result)
    }

    if (url.pathname === '/live/stop' && req.method === 'POST') {
      return json(res, 200, await stopSession('stopped by the owner'))
    }

    if (url.pathname === '/live/input' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await applyInput(body)
      return json(res, result.ok ? 200 : 400, result)
    }

    if (url.pathname === '/live/stream' && req.method === 'GET') {
      if (!session) return json(res, 409, { error: 'no live session' })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write(`event: hello\ndata: ${JSON.stringify(status())}\n\n`)
      // Show the page immediately instead of waiting for the next repaint.
      if (session.lastFrame) {
        res.write(`event: frame\ndata: ${JSON.stringify({ data: session.lastFrame })}\n\n`)
      }
      session.clients.add(res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* closed */
        }
      }, 15_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        session?.clients.delete(res)
      })
      return undefined
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    return json(res, 500, { error: err?.message ?? String(err) })
  }
})

server.listen(PORT, BIND, () => log(`listening ${BIND}:${PORT}`))

async function shutdown() {
  await stopSession('service shutting down')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { startSession, stopSession, applyInput, status, callInProgress }
