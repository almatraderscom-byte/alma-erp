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
 * Push any new session events to the server's feed. Outbound HTTPS only, like
 * everything else here. Best-effort: a failed push leaves the mark where it
 * was, so the next tick re-sends the same batch and the server's unique key
 * drops duplicates. Never allowed to take the poll loop down.
 */
async function pushSessionEvents(token) {
  if (Date.now() - lastEventPushAt < EVENT_PUSH_MIN_INTERVAL_MS) return
  let mod
  try {
    mod = await import('./sessions.mjs')
  } catch {
    return // session driver absent — nothing to stream
  }
  const batches = mod.collectUnpushedEvents()
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
      if (res.ok) mod.markEventsPushed(batch.sessionId, batch.lastSeq)
      else log(`event push rejected (${res.status}) for session ${batch.sessionId}`)
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
  await flushPendingResult(cfg.token)
  let backoff = 0

  for (;;) {
    try {
      if (existsSync(PAUSE_FILE)) {
        await sleep(POLL_INTERVAL_IDLE_MS)
        continue
      }

      const { command, paused } = await pollOnce(cfg.token)
      backoff = 0

      // Session events flow on the same heartbeat as the poll — no extra timer,
      // no extra connection when nothing is happening.
      await pushSessionEvents(cfg.token).catch(() => {})

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
