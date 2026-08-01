#!/usr/bin/env node
/**
 * ALMA Mac Agent — the daemon that lets the owner's assistant work on his Mac.
 *
 * It is deliberately small, dependency-free, and outbound-only:
 *   • Nothing listens. No port, no tunnel, no inbound SSH. The Mac makes HTTPS
 *     calls it initiated and nothing else, so there is no socket for anyone to
 *     find — including whoever might one day compromise the server.
 *   • Every command is re-classified HERE, against the copy of the policy that
 *     shipped with this file. The server deciding "this is fine" is not enough;
 *     this is the process standing next to the owner's files.
 *   • It runs under launchd as the owner's own user, never as root. `sudo` is a
 *     RED word, so even an approved command cannot escalate.
 *
 * Lifecycle: pair once with a one-time code → long-poll for work → run → post the
 * result back. launchd restarts it if it dies; a restart loses nothing because the
 * queue lives in Postgres.
 *
 * Usage:
 *   node agent.mjs pair <CODE>     one-time pairing
 *   node agent.mjs run             the daemon loop (what launchd calls)
 *   node agent.mjs status          local health/config check
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyCommand, resolveTimeoutMs, capOutput, DEFAULT_ALLOWED_DIRS } from './policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const CONFIG_DIR = join(HOME, '.alma-mac-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const LOG_FILE = join(CONFIG_DIR, 'agent.log')
/** Owner's local override: `touch ~/.alma-mac-agent/PAUSED` and nothing runs. */
const PAUSE_FILE = join(CONFIG_DIR, 'PAUSED')

const AGENT_VERSION = '1.0.0'
// Overridable so the integration test can drive the real daemon at speed instead
// of testing a stubbed copy of it.
const POLL_INTERVAL_MS = Number(process.env.ALMA_POLL_MS) || 3_000
const POLL_INTERVAL_IDLE_MS = Number(process.env.ALMA_POLL_IDLE_MS) || 5_000
const BACKOFF_MAX_MS = 60_000

// ---------------------------------------------------------------------------
// Config + logging
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

function readConfig() {
  ensureConfigDir()
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  ensureConfigDir()
  const next = { ...readConfig(), ...patch }
  // 0600: the bearer token lives here, so it is readable by the owner alone.
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try {
    ensureConfigDir()
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    /* logging must never take the daemon down */
  }
}

function baseUrl() {
  const cfg = readConfig()
  return (process.env.ALMA_BASE_URL || cfg.baseUrl || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Vercel SSO protection sits in front of preview deployments. A browser passes it
 * with a session cookie; a daemon cannot, so testing against a branch preview
 * needs the project's automation-bypass secret. Supplied by env or config —
 * never committed. Production does not need it.
 */
function bypassToken() {
  return process.env.ALMA_VERCEL_BYPASS?.trim() || readConfig().bypassToken || ''
}

async function api(path, { method = 'GET', body, token, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const bypass = bypassToken()
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'false' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON error page */
    }
    return { ok: res.ok, status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Expand a leading `~` so policy comparisons and spawn() agree on one form. */
function expandHome(p) {
  if (!p) return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return join(HOME, p.slice(2))
  return p
}

const ALLOWED_DIRS_ABS = DEFAULT_ALLOWED_DIRS.map(expandHome)

/**
 * Resolve the working directory for a command, defaulting to the ERP checkout.
 * Returns null when the request points outside the allowlist — the caller turns
 * that into a refusal rather than silently running somewhere else.
 */
function resolveCwd(requested) {
  const fallback = join(HOME, 'alma-erp')
  if (!requested) return existsSync(fallback) ? fallback : HOME
  const abs = expandHome(String(requested))
  if (abs.includes('..')) return null
  const inside = ALLOWED_DIRS_ABS.some((d) => abs === d || abs.startsWith(`${d}/`))
  if (!inside) return null
  return existsSync(abs) ? abs : null
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one shell command with a hard timeout and a capped buffer.
 *
 * `shell: false` is not an option here — the owner's commands legitimately use
 * pipes and globs — so the safety comes from the classifier having already
 * refused everything dangerous, plus the environment scrubbing below.
 */
function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    // Strip the obvious secret-bearing variables from the child's environment.
    // A command that legitimately needs them is one the owner should run himself.
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/(_KEY|_TOKEN|_SECRET|PASSWORD|_PAT|CREDENTIALS)$/i.test(key)) delete env[key]
    }
    env.ALMA_MAC_AGENT = '1'
    // Never let a command block forever waiting for a human at a prompt.
    env.GIT_TERMINAL_PROMPT = '0'
    env.CI = '1'

    // `detached` puts the command in its OWN process group, so the deadline can
    // take the whole tree. Without it a script that backgrounded work kept
    // running after we reported a timeout (Codex review round 2).
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const killTree = (signal) => {
      try {
        process.kill(-child.pid, signal) // negative pid = the whole group
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => {
      killed = true
      killTree('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      if (stdout.length < 200_000) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 200_000) stderr += d.toString()
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: String(err?.message ?? err) })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !killed && code === 0,
        exitCode: code,
        stdout: capOutput(stdout),
        stderr: capOutput(stderr),
        error: killed ? `timeout after ${timeoutMs}ms` : null,
      })
    })
  })
}

/**
 * Does any argument RESOLVE to something outside the allowed folders?
 *
 * The textual check refuses `/`, `~` and `..`, but a tracked symlink inside the
 * checkout — `secret-link -> ~/.config/gh/hosts.yml` — is none of those, and the
 * shell follows it happily (Codex review round 2). Only the real path tells the
 * truth, and only this side can ask for it.
 */
function argEscapesAllowlist(command, cwd) {
  for (const raw of command.split(/\s+/).slice(1)) {
    const token = raw.replace(/^["']|["']$/g, '')
    if (!token || token.startsWith('-')) continue
    const candidate = token.startsWith('/') ? token : join(cwd, token)
    let real
    try {
      real = realpathSync(candidate)
    } catch {
      continue // does not exist — nothing to follow
    }
    if (!ALLOWED_DIRS_ABS.some((d) => real === d || real.startsWith(`${d}/`))) return real
  }
  return null
}

/**
 * Keep-awake. The daemon runs fine while the screen is locked, but a Mac that
 * SLEEPS stops polling entirely — which is what "my agent went quiet" actually
 * looks like. `caffeinate` held open for as long as we want it is the supported
 * way to prevent that; killing the child gives sleep straight back.
 */
let caffeinateChild = null

function setKeepAwake(on) {
  if (!on) {
    try {
      caffeinateChild?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    caffeinateChild = null
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ keepAwake: false }) }
  }
  if (caffeinateChild && !caffeinateChild.killed) {
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ keepAwake: true, alreadyOn: true }) }
  }
  try {
    // -i idle, -m disk, -s system. Display sleep is deliberately NOT prevented:
    // the screen going dark is fine, the machine going to sleep is not.
    caffeinateChild = spawn('/usr/bin/caffeinate', ['-ims'], { stdio: 'ignore', detached: false })
    caffeinateChild.on('close', () => { caffeinateChild = null })
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ keepAwake: true }) }
  } catch (err) {
    return { ok: false, exitCode: null, error: String(err?.message ?? err) }
  }
}

/** `screencapture` to a temp file, returned as a base64 data URI. */
function screenshot() {
  return new Promise((resolve) => {
    const out = join(CONFIG_DIR, `shot-${Date.now()}.jpg`)
    // -R scales nothing, so a Retina display produced a >4.5 MB body that Vercel
    // rejected before the route ever ran. Capture, then downscale to 1600px wide
    // at moderate quality — readable, and safely under the transport limit.
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'jpg', out], (err) => {
      if (err) return resolve({ ok: false, error: String(err.message ?? err) })
      // sips ships with macOS; if it fails we still return the original.
      execFile('/usr/bin/sips', ['-Z', '1600', '-s', 'formatOptions', '60', out], () => {
        try {
          const b64 = readFileSync(out).toString('base64')
          rmSync(out, { force: true })
          if (b64.length > 2_900_000) {
            return resolve({ ok: false, error: 'screenshot_too_large: স্ক্রিনশটটা পাঠানোর সীমার চেয়ে বড়।' })
          }
          return resolve({ ok: true, stdout: `data:image/jpeg;base64,${b64}` })
        } catch (e) {
          return resolve({ ok: false, error: String(e?.message ?? e) })
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// L7 — live screen streaming
//
// A ~1.5s capture loop the OWNER starts explicitly from the dock (cost +
// privacy — it never starts itself). Each frame is downscaled hard (the
// transport rejects big bodies and a phone is on the other end) and upserted
// server-side as the device's single newest frame; the dock's existing
// screenshot channel renders it. Auto-stops at the deadline, on the
// kill-switch, or on the local PAUSE file — silence is the default state.
// ---------------------------------------------------------------------------

const STREAM_FRAME_INTERVAL_MS = Number(process.env.ALMA_STREAM_FRAME_MS) || 1_500
const STREAM_DEFAULT_SECONDS = 180
const STREAM_MAX_SECONDS = 300

let streamTimer = null
let streamDeadline = 0
let streamBusy = false

function stopScreenStream(reason) {
  if (streamTimer) {
    clearInterval(streamTimer)
    streamTimer = null
    log('screen stream stopped', reason ? `(${reason})` : '')
  }
}

async function captureFrame() {
  const out = join(CONFIG_DIR, 'stream-frame.jpg')
  return new Promise((resolve) => {
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'jpg', out], (err) => {
      if (err) return resolve(null)
      // Harder downscale than the one-off screenshot: this runs every ~1.5s.
      execFile('/usr/bin/sips', ['-Z', '900', '-s', 'formatOptions', '50', out], () => {
        try {
          const b64 = readFileSync(out).toString('base64')
          rmSync(out, { force: true })
          if (b64.length > 1_400_000) return resolve(null) // give up, not overflow
          resolve(`data:image/jpeg;base64,${b64}`)
        } catch {
          resolve(null)
        }
      })
    })
  })
}

function startScreenStream(token, maxSeconds) {
  const seconds = Math.min(Math.max(Number(maxSeconds) || STREAM_DEFAULT_SECONDS, 10), STREAM_MAX_SECONDS)
  streamDeadline = Date.now() + seconds * 1_000
  if (streamTimer) return { ok: true, exitCode: 0, stdout: JSON.stringify({ streaming: true, extended: true, seconds }) }

  log(`screen stream started (${seconds}s cap)`)
  streamTimer = setInterval(async () => {
    if (Date.now() > streamDeadline || pausedByServer || existsSync(PAUSE_FILE)) {
      return stopScreenStream(Date.now() > streamDeadline ? 'deadline' : 'paused')
    }
    if (streamBusy) return
    streamBusy = true
    try {
      const frame = await captureFrame()
      if (frame) {
        const res = await api('/api/assistant/mac-agent/frames', {
          method: 'POST',
          token,
          body: { dataUri: frame },
          timeoutMs: 10_000,
        }).catch(() => null)
        // The frames response doubles as the STOP channel — the command queue
        // is serial and a long shell command must not keep the screen
        // streaming after the owner pressed stop. 409 = kill-switch off,
        // 401 = this device was unpaired mid-stream: same conclusion, stop.
        if (res?.json?.stop || res?.status === 409 || res?.status === 401) {
          stopScreenStream('owner (frame channel)')
        }
      }
    } finally {
      streamBusy = false
    }
  }, STREAM_FRAME_INTERVAL_MS)
  return { ok: true, exitCode: 0, stdout: JSON.stringify({ streaming: true, seconds }) }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/** Handlers registered by the M2 session driver, keyed by action name. */
export const extraHandlers = new Map()

// M2 session verbs (claude / codex). Loaded lazily and optionally: an install that
// only wants terminal control still runs with sessions.mjs absent.
try {
  const mod = await import('./sessions.mjs')
  mod.registerSessionHandlers(extraHandlers, ALLOWED_DIRS_ABS)
} catch (err) {
  log('session driver not loaded:', String(err?.message ?? err))
}

// W3 ui_* verbs + app chat mirroring. Also optional; registered AFTER the
// session driver on purpose — the UI driver wraps session_send so a dock reply
// aimed at a mirrored app chat fails honestly instead of `session_not_found`.
try {
  const ui = await import('./ui-driver.mjs')
  ui.registerUiHandlers(extraHandlers, {
    isPaused: () => pausedByServer || existsSync(PAUSE_FILE),
    // The out-of-band STOP check for UI actions. The command queue is serial,
    // so while a ui_* verb waits out the owner-at-keyboard gate the poll loop
    // is blocked and `pausedByServer` goes stale — the owner's STOP (which
    // marks the delivered row cancelled) and the kill-switch would otherwise
    // be invisible until the action fired minutes later (Codex P1). One
    // daemon-authenticated read against /status answers both.
    checkCancelled: async (commandId) => {
      const qs = commandId ? `?commandId=${encodeURIComponent(commandId)}` : ''
      const res = await api(`/api/assistant/mac-agent/status${qs}`, {
        token: activeToken,
        timeoutMs: 8_000,
      })
      if (res.status === 401) return { cancelled: true, disabled: true } // unpaired mid-wait
      if (!res.ok || !res.json) return null // network blip: not evidence of a STOP
      return {
        cancelled: res.json.commandStatus === 'cancelled' || res.json.commandStatus === 'missing',
        disabled: res.json.enabled === false,
      }
    },
  })
} catch (err) {
  log('ui driver not loaded:', String(err?.message ?? err))
}

async function handleCommand(cmd) {
  const params = cmd.params ?? {}

  if (cmd.action === 'ping') {
    // Report CLI readiness with the pong: the owner should learn that the Claude
    // CLI has no login from a status check, not from a session that silently
    // does nothing.
    let cli = null
    try {
      const mod = await import('./sessions.mjs')
      cli = mod.cliHealth()
    } catch {
      cli = null
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ pong: true, host: hostname(), version: AGENT_VERSION, cli }),
    }
  }

  if (cmd.action === 'screenshot') {
    return await screenshot()
  }

  if (cmd.action === 'screen_stream') {
    const mode = String(params.mode ?? 'start')
    if (mode === 'stop') {
      stopScreenStream('owner')
      return { ok: true, exitCode: 0, stdout: JSON.stringify({ streaming: false }) }
    }
    return startScreenStream(activeToken, params.maxSeconds)
  }

  if (cmd.action === 'power') {
    const mode = String(params.mode ?? 'status')
    if (mode === 'keep_awake') return setKeepAwake(true)
    if (mode === 'allow_sleep') return setKeepAwake(false)
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ keepAwake: Boolean(caffeinateChild && !caffeinateChild.killed) }),
    }
  }

  if (cmd.action === 'run_command') {
    const command = String(params.command ?? '')
    const cwd = resolveCwd(params.cwd)
    if (!cwd) {
      return { ok: false, exitCode: null, error: 'cwd_not_allowed: অনুমোদিত ফোল্ডারের বাইরে বা ফোল্ডারটি নেই।' }
    }

    // The second gate. The server already classified this, but that check ran on a
    // machine the owner does not physically control; this one does not.
    const verdict = classifyCommand(command, { cwd, allowedDirs: ALLOWED_DIRS_ABS })
    if (verdict.level === 'red') {
      log('REFUSED (red):', verdict.code, '|', command)
      return { ok: false, exitCode: null, error: `refused_by_daemon:${verdict.code} — ${verdict.reasonBn}` }
    }
    if (verdict.level === 'amber' && !params.approved) {
      log('REFUSED (amber without approval):', command)
      return { ok: false, exitCode: null, error: 'refused_by_daemon:missing_approval' }
    }

    // Green means "we read the literal text and it only reads project files".
    // A symlink makes that literally untrue, so resolve before trusting it.
    if (verdict.level === 'green') {
      const escaped = argEscapesAllowlist(command, cwd)
      if (escaped) {
        log('REFUSED (symlink escapes allowlist):', escaped)
        return {
          ok: false,
          exitCode: null,
          error: `refused_by_daemon:path_escapes_allowlist — ${escaped} প্রজেক্ট ফোল্ডারের বাইরে।`,
        }
      }
    }

    const timeoutMs = resolveTimeoutMs(Number(params.timeoutMs))
    log(`RUN [${verdict.level}]`, command, `(cwd=${cwd})`)
    return await runShell(command, cwd, timeoutMs)
  }

  // A fully unattended CLI session is a standing grant over the owner's files.
  // The server promises an approval card for it; this is the daemon refusing to
  // take that promise on trust — the same reason RED commands are re-judged here
  // (found in review: only run_command had a backstop).
  if (cmd.action === 'session_open' && String(params.permissionMode ?? '') === 'bypass' && !params.approved) {
    log('REFUSED bypass session without approval')
    return { ok: false, exitCode: null, error: 'refused_by_daemon:bypass_requires_approval' }
  }

  const extra = extraHandlers.get(cmd.action)
  if (extra) return await extra(params, cmd)

  return { ok: false, exitCode: null, error: `unknown_action:${cmd.action}` }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function pollOnce(token) {
  const res = await api('/api/assistant/mac-agent/poll', { token })
  if (res.status === 401) throw new Error('unauthorized — pair again')
  if (!res.ok) throw new Error(`poll failed: ${res.status}`)
  return res.json ?? {}
}

const PENDING_RESULT_FILE = join(CONFIG_DIR, 'pending-result.json')

/**
 * Deliver a result, and do not lose it if the network blinks.
 *
 * The row is already marked delivered by the time we run, so a dropped POST used
 * to mean the owner never learned what happened — the command looked stuck
 * forever (found in review). The result is written to disk first, retried until
 * the server accepts it, and survives a daemon restart.
 */
function savePendingResult(payload) {
  try {
    ensureConfigDir()
    writeFileSync(PENDING_RESULT_FILE, JSON.stringify(payload), { mode: 0o600 })
  } catch {
    /* disk full / read-only: the in-memory retry below still applies */
  }
}

function clearPendingResult() {
  try {
    if (existsSync(PENDING_RESULT_FILE)) rmSync(PENDING_RESULT_FILE)
  } catch {
    /* nothing to clear */
  }
}

async function deliverResult(token, payload) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const res = await api('/api/assistant/mac-agent/result', { method: 'POST', token, body: payload })
      // A 404 means the row is gone (cancelled, or the owner unpaired) — the
      // result has nowhere to land, so stop rather than retry forever.
      if (res.ok || res.status === 404) {
        clearPendingResult()
        return true
      }
      log(`result POST rejected (${res.status}) — attempt ${attempt}`)
    } catch (err) {
      log(`result POST failed — attempt ${attempt}:`, String(err?.message ?? err))
    }
    await sleep(Math.min(2_000 * 2 ** (attempt - 1), 30_000))
  }
  log('result still undelivered after retries — kept on disk for next start')
  return false
}

async function postResult(token, commandId, result) {
  const payload = {
    commandId,
    ok: Boolean(result.ok),
    exitCode: result.exitCode ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  }
  savePendingResult(payload)
  await deliverResult(token, payload)
}

/** On start, hand over anything a previous run finished but could not deliver. */
async function flushPendingResult(token) {
  if (!existsSync(PENDING_RESULT_FILE)) return
  try {
    const payload = JSON.parse(readFileSync(PENDING_RESULT_FILE, 'utf8'))
    log('delivering a result left over from the previous run:', payload.commandId)
    await deliverResult(token, payload)
  } catch {
    clearPendingResult()
  }
}

// ---------------------------------------------------------------------------
// L4 — session event streaming (what a session is SAYING, into the live dock)
// ---------------------------------------------------------------------------

const EVENT_PUSH_MIN_INTERVAL_MS = Number(process.env.ALMA_EVENT_PUSH_MS) || 2_500
let lastEventPushAt = 0
/**
 * The owner's kill-switch, as last reported by the poll endpoint. While true,
 * NOTHING leaves this machine — including a running CLI child's transcript
 * (Codex round 7: events used to keep uploading after the switch went off).
 */
let pausedByServer = false
let pushingEvents = false
/** The paired token, for handlers that post outside the result path (frames). */
let activeToken = null

/**
 * Push any new session events to the server's feed. Outbound HTTPS only, like
 * everything else here. Best-effort: a failed push leaves the mark where it
 * was, so the next tick re-sends the same batch and the server's unique key
 * drops duplicates. Never allowed to take the poll loop down.
 */
async function pushSessionEvents(token) {
  if (Date.now() - lastEventPushAt < EVENT_PUSH_MIN_INTERVAL_MS) return
  let mod = null
  let ui = null
  try {
    mod = await import('./sessions.mjs')
  } catch {
    /* session driver absent */
  }
  try {
    ui = await import('./ui-driver.mjs')
  } catch {
    /* ui driver absent */
  }
  // W3: mirrored app-chat messages ride the SAME pipe as CLI transcripts —
  // one endpoint, one dedupe key, zero render changes in the docks.
  const batches = [
    ...(mod ? mod.collectUnpushedEvents().map((b) => ({ ...b, mark: mod.markEventsPushed })) : []),
    ...(ui ? ui.collectUnpushedUiEvents().map((b) => ({ ...b, mark: ui.markUiEventsPushed })) : []),
  ]
  if (batches.length === 0) return
  lastEventPushAt = Date.now()

  for (const batch of batches) {
    try {
      const res = await api('/api/assistant/mac-agent/events', {
        method: 'POST',
        token,
        body: { sessionId: batch.sessionId, tool: batch.tool, events: batch.events },
        timeoutMs: 15_000,
      })
      if (res.ok) batch.mark(batch.sessionId, batch.lastSeq)
      else {
        log(`event push rejected (${res.status}) for session ${batch.sessionId}`)
        // 409 = the owner's kill-switch — while a long command blocks the poll
        // loop this response is the only place the daemon hears it, and app
        // mirrors must fall silent like everything else (same rule as frames).
        if (res.status === 409 && ui) ui.stopAllMirrors('kill_switch')
      }
    } catch (err) {
      log('event push failed:', String(err?.message ?? err))
    }
  }
}

async function loop() {
  const cfg = readConfig()
  if (!cfg.token) {
    log('not paired — run: node agent.mjs pair <CODE>')
    process.exit(1)
  }

  log(`ALMA Mac Agent v${AGENT_VERSION} starting · host=${hostname()} · server=${baseUrl()}`)
  activeToken = cfg.token
  await flushPendingResult(cfg.token)
  let backoff = 0

  // Session events drain on their OWN timer, not the poll heartbeat: a shell
  // command can hold handleCommand for up to ten minutes, and a session's
  // question must not wait for it (Codex round 7). Still outbound-only, still
  // silent while paused, never re-entrant.
  setInterval(() => {
    if (pausedByServer || pushingEvents || existsSync(PAUSE_FILE)) return
    pushingEvents = true
    pushSessionEvents(cfg.token)
      .catch(() => {})
      .finally(() => {
        pushingEvents = false
      })
  }, EVENT_PUSH_MIN_INTERVAL_MS)

  for (;;) {
    try {
      if (existsSync(PAUSE_FILE)) {
        await sleep(POLL_INTERVAL_IDLE_MS)
        continue
      }

      const { command, paused } = await pollOnce(cfg.token)
      backoff = 0
      pausedByServer = Boolean(paused)

      if (paused || !command) {
        await sleep(paused ? POLL_INTERVAL_IDLE_MS : POLL_INTERVAL_MS)
        continue
      }

      let result
      try {
        result = await handleCommand(command)
      } catch (err) {
        result = { ok: false, exitCode: null, error: String(err?.message ?? err) }
      }
      await postResult(cfg.token, command.id, result)
    } catch (err) {
      // Network blips and deploys are normal; back off instead of spinning.
      backoff = Math.min(backoff ? backoff * 2 : 2_000, BACKOFF_MAX_MS)
      log('loop error:', String(err?.message ?? err), `— retrying in ${backoff}ms`)
      await sleep(backoff)
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function pair(code) {
  if (!code) {
    console.error('usage: node agent.mjs pair <CODE>')
    process.exit(1)
  }
  const res = await api('/api/assistant/mac-agent/pair', {
    method: 'POST',
    body: {
      code,
      deviceName: hostname(),
      meta: { host: hostname(), node: process.version, agentVersion: AGENT_VERSION, dir: HERE },
    },
  })
  if (!res.ok || !res.json?.token) {
    console.error('pairing failed:', res.status, res.text?.slice(0, 300))
    process.exit(1)
  }
  writeConfig({
    token: res.json.token,
    deviceId: res.json.deviceId,
    baseUrl: baseUrl(),
    ...(bypassToken() ? { bypassToken: bypassToken() } : {}),
  })
  log('paired ✓ device', res.json.deviceId)
}

async function status() {
  const cfg = readConfig()
  console.log(
    JSON.stringify(
      {
        version: AGENT_VERSION,
        paired: Boolean(cfg.token),
        deviceId: cfg.deviceId ?? null,
        server: baseUrl(),
        paused: existsSync(PAUSE_FILE),
        allowedDirs: ALLOWED_DIRS_ABS,
        configFile: CONFIG_FILE,
        logFile: LOG_FILE,
      },
      null,
      2,
    ),
  )
}

const [, , cmd, arg] = process.argv
if (cmd === 'pair') await pair(arg)
else if (cmd === 'status') await status()
else if (cmd === 'run' || !cmd) await loop()
else {
  console.error(`unknown command: ${cmd}\nusage: node agent.mjs [pair <CODE>|run|status]`)
  process.exit(1)
}
