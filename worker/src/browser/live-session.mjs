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
import {
  ensureProfile,
  enforceProfileBudget,
  listProfiles,
  purgeAllProfiles,
  purgeProfile,
  totalBytes,
  trimProfileCaches,
} from './profile-store.mjs'

const PORT = Number(process.env.BROWSER_LIVE_PORT ?? 8781)
const BIND = process.env.BROWSER_LIVE_BIND ?? '0.0.0.0'
/** Shared with the app; the same token the internal job endpoints use. */
const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
/** SIP gateway control API, used only to ask whether a call is up right now. */
const SIP_BASE = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')

/**
 * Stream shape — tunable, because one setting cannot serve both clients.
 *
 * Measured on the first build: a 1280×800 JPEG at quality 50 is ~145 KB per
 * frame, so 5 fps is ~5.8 Mbit/s. That is fine over wifi on a laptop and plainly
 * unacceptable on a phone's mobile data — it is the owner's own money and his
 * own battery. So the capture is parameterised and the caller says what it can
 * afford: a desktop asks for the full picture, a phone asks for a tenth of it.
 *
 * The knobs are on the CAPTURE, not on the encoder-per-viewer, because this box
 * has two cores and also carries the phone calls — re-encoding one frame per
 * viewer would spend exactly the CPU the call audio needs. A viewer wanting
 * fewer frames than the session produces simply drops the extras.
 */
const STREAM_DEFAULTS = { fps: 5, quality: 50, width: 1280, height: 800 }
/** Bounds — a bad number from a client must not be able to melt the box. */
const STREAM_LIMITS = { fps: [1, 10], quality: [20, 80], width: [480, 1600] }
/**
 * Floor for a page that is NOT moving. CDP only emits a screencast frame when
 * something repaints, so a finished, static page produces nothing at all — a
 * viewer who connects at that moment would sit staring at an empty panel. This
 * interval is how often we capture one ourselves to keep the picture true.
 */
const STATIC_CAPTURE_MS = 1000
/** The page's own viewport stays fixed; only the picture we SEND is scaled. */
const VIEWPORT = { width: 1280, height: 800 }
const IDLE_PAUSE_MS = 60_000
const ABSOLUTE_MAX_MS = 20 * 60_000
const CALL_CHECK_INTERVAL_MS = 5_000

/** The single live session, or null. One at a time is a hard rule, not a default. */
let session = null

/** Clamp one stream knob into its safe range; undefined keeps the current value. */
function clampStream(input, current) {
  const out = { ...current }
  const pick = (key, limits) => {
    const n = Number(input?.[key])
    if (!Number.isFinite(n)) return
    out[key] = Math.round(Math.min(Math.max(n, limits[0]), limits[1]))
  }
  pick('fps', STREAM_LIMITS.fps)
  pick('quality', STREAM_LIMITS.quality)
  pick('width', STREAM_LIMITS.width)
  // Height follows width so the picture never distorts — the page's own viewport
  // is unchanged, we are only choosing how big a copy of it to send.
  out.height = Math.round((out.width * VIEWPORT.height) / VIEWPORT.width)
  return out
}

/** Start (or restart) the screencast with the session's current stream settings. */
async function applyScreencast() {
  if (!session) return
  const { quality, width, height } = session.stream
  await session.cdp.send('Page.stopScreencast').catch(() => {})
  await session.cdp
    .send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
    .catch(() => {})
}

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

/** Consecutive failed reads of the gateway. Reset on any successful answer. */
let callCheckFailures = 0
/** Last answer we actually got from the gateway, used to ride out a single blip. */
let lastKnownCallState = false

/**
 * Is a call up right now?
 *
 * Failing closed is right when STARTING a session — refusing to open a browser
 * costs the owner one retry. It is wrong for a session already running: this box
 * has two cores, and a busy Chromium can make a local HTTP round-trip miss a
 * tight deadline, which would pause the live view exactly when it is being used.
 * That is the feature fighting itself.
 *
 * So a single unanswered check keeps the last known state, and only a sustained
 * inability to reach the gateway (STRICT, or several failures in a row) is
 * treated as "assume a call". `strict` is passed when starting.
 */
async function callInProgress({ strict = false } = {}) {
  if (!SIP_BASE) return false // no gateway configured on this host ⇒ nothing to protect
  try {
    const res = await fetch(`${SIP_BASE}/api/v1/active`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`gateway ${res.status}`)
    const body = await res.json().catch(() => null)
    const calls = body?.calls ?? body?.active ?? []
    callCheckFailures = 0
    lastKnownCallState = Array.isArray(calls) ? calls.length > 0 : Boolean(calls)
    return lastKnownCallState
  } catch {
    callCheckFailures += 1
    if (strict) return true
    // Three misses in a row (~15s) is not a blip any more — assume a call.
    if (callCheckFailures >= 3) return true
    return lastKnownCallState
  }
}

// ─── session lifecycle ───────────────────────────────────────────────────────

async function startSession({ startUrl, goal, profile, stream }) {
  if (session) return { ok: false, error: 'a live session is already running' }
  // Strict here: opening a browser is new load on a two-core box that also runs
  // the phone system, so an unverifiable gateway means "not now".
  if (await callInProgress({ strict: true })) {
    return { ok: false, error: 'a call is in progress — live browsing is paused so the call audio stays clean' }
  }

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return { ok: false, error: 'playwright_not_installed' }
  }

  const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage']
  let context
  let close
  let profileKey = null
  let budget = null

  if (profile) {
    // A named profile keeps its cookies between sessions — that is what makes
    // "log in once" mean anything. The budget is enforced inside ensureProfile,
    // BEFORE the directory is used, so a new login cannot fill the disk.
    const prepared = await ensureProfile(profile)
    profileKey = prepared.key
    budget = prepared.budget
    context = await chromium.launchPersistentContext(prepared.dir, {
      headless: true,
      args: launchArgs,
      viewport: VIEWPORT,
    })
    close = () => context.close()
  } else {
    const browser = await chromium.launch({ headless: true, args: launchArgs })
    context = await browser.newContext({ viewport: VIEWPORT })
    close = () => browser.close()
  }

  const page = context.pages()[0] ?? (await context.newPage())
  await page.setViewportSize(VIEWPORT).catch(() => {})
  const cdp = await context.newCDPSession(page)

  const id = `live_${Date.now().toString(36)}`
  session = {
    id,
    goal: String(goal ?? ''),
    profileKey,
    close,
    context,
    page,
    cdp,
    clients: new Set(),
    stream: clampStream(stream, STREAM_DEFAULTS),
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

  // Frames are throttled to the session's fps. Every frame is ACKed even when it
  // is dropped — Chromium stops sending until the previous one is acknowledged.
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    if (!session || session.paused) return
    const now = Date.now()
    if (now - session.lastFrameSentAt < 1000 / session.stream.fps) return
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
        const buf = await session.page.screenshot({ type: 'jpeg', quality: session.stream.quality })
        session.lastFrameSentAt = Date.now()
        session.lastFrame = buf.toString('base64')
        broadcast('frame', { data: session.lastFrame })
      } catch {
        /* mid-navigation screenshots can fail; the next tick covers it */
      }
    }, STATIC_CAPTURE_MS),
  )

  await applyScreencast()

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
  return { ok: true, sessionId: id, viewport: VIEWPORT, profile: profileKey, budget }
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
  void applyScreencast()
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
  await current.close().catch(() => {})
  log(`session ${current.id} closed — ${reason ?? 'closed'}`)
  return { ok: true }
}

function broadcast(event, payload) {
  if (session) broadcastTo(session, event, payload)
}

function broadcastTo(target, event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  const now = Date.now()
  for (const client of target.clients) {
    // A viewer may ask for fewer frames than the session produces (a phone on
    // mobile data). Non-frame events are never dropped — a pause or an ending is
    // not something a slow client should miss.
    if (event === 'frame' && client.minFrameGapMs) {
      if (now - (client.lastFrameAt ?? 0) < client.minFrameGapMs) continue
      client.lastFrameAt = now
    }
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
    profile: session.profileKey,
    stream: session.stream,
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

    // Change the picture mid-session — a phone joining a session a laptop
    // started should not have to tear it down to get a stream it can afford.
    if (url.pathname === '/live/tune' && req.method === 'POST') {
      if (!session) return json(res, 409, { error: 'no live session' })
      const body = JSON.parse((await readBody(req)) || '{}')
      session.stream = clampStream(body, session.stream)
      if (!session.paused) await applyScreencast()
      log(`stream tuned: ${session.stream.fps}fps q${session.stream.quality} ${session.stream.width}px`)
      return json(res, 200, { ok: true, stream: session.stream })
    }

    if (url.pathname === '/live/stop' && req.method === 'POST') {
      return json(res, 200, await stopSession('stopped by the owner'))
    }

    if (url.pathname === '/live/input' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await applyInput(body)
      return json(res, result.ok ? 200 : 400, result)
    }

    // ── saved logins on disk ─────────────────────────────────────────────────
    // A cleanup the owner cannot trigger himself is a cleanup he cannot trust,
    // so what is stored, what it costs, and how to drop it are all first-class.
    if (url.pathname === '/profiles' && req.method === 'GET') {
      const profiles = await listProfiles()
      return json(res, 200, {
        profiles: profiles.map(({ key, bytes, lastUsedAt }) => ({ key, bytes, lastUsedAt })),
        totalBytes: profiles.reduce((s, p) => s + p.bytes, 0),
      })
    }

    if (url.pathname === '/profiles/purge' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      // A profile in use by the running session would come back half-deleted.
      if (session?.profileKey && (body.all || session.profileKey === body.key)) {
        await stopSession('profile cleared by the owner')
      }
      if (body.all) return json(res, 200, await purgeAllProfiles())
      if (!body.key) return json(res, 400, { error: 'key or all is required' })
      // 'cachesOnly' is the gentle option: frees the bulk, keeps the login.
      const freed = body.cachesOnly ? await trimProfileCaches(body.key) : await purgeProfile(body.key)
      return json(res, 200, { freed, key: body.key, keptLogin: Boolean(body.cachesOnly) })
    }

    if (url.pathname === '/profiles/enforce' && req.method === 'POST') {
      return json(res, 200, { ...(await enforceProfileBudget()), totalBytes: await totalBytes() })
    }

    if (url.pathname === '/live/stream' && req.method === 'GET') {
      if (!session) return json(res, 409, { error: 'no live session' })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      // ?fps=N lets one viewer take fewer frames than the session produces.
      // It can only ask for LESS: raising the session rate is a capture change,
      // and one viewer must not be able to spend the whole box's CPU.
      const wantFps = Number(url.searchParams.get('fps'))
      res.minFrameGapMs =
        Number.isFinite(wantFps) && wantFps > 0 && wantFps < session.stream.fps ? 1000 / wantFps : 0
      res.lastFrameAt = 0

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
