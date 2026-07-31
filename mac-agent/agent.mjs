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
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
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
const POLL_INTERVAL_MS = 3_000
const POLL_INTERVAL_IDLE_MS = 5_000
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

async function api(path, { method = 'GET', body, token, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
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

/** `screencapture` to a temp file, returned as a base64 data URI. */
function screenshot() {
  return new Promise((resolve) => {
    const out = join(CONFIG_DIR, `shot-${Date.now()}.jpg`)
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'jpg', out], (err) => {
      if (err) return resolve({ ok: false, error: String(err.message ?? err) })
      try {
        const b64 = readFileSync(out).toString('base64')
        return resolve({ ok: true, stdout: `data:image/jpeg;base64,${b64}` })
      } catch (e) {
        return resolve({ ok: false, error: String(e?.message ?? e) })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/** Handlers registered by the M2 session driver, keyed by action name. */
export const extraHandlers = new Map()

async function handleCommand(cmd) {
  const params = cmd.params ?? {}

  if (cmd.action === 'ping') {
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ pong: true, host: hostname(), version: AGENT_VERSION }) }
  }

  if (cmd.action === 'screenshot') {
    return await screenshot()
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

    const timeoutMs = resolveTimeoutMs(Number(params.timeoutMs))
    log(`RUN [${verdict.level}]`, command, `(cwd=${cwd})`)
    return await runShell(command, cwd, timeoutMs)
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

async function postResult(token, commandId, result) {
  await api('/api/assistant/mac-agent/result', {
    method: 'POST',
    token,
    body: {
      commandId,
      ok: Boolean(result.ok),
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ?? null,
    },
  })
}

async function loop() {
  const cfg = readConfig()
  if (!cfg.token) {
    log('not paired — run: node agent.mjs pair <CODE>')
    process.exit(1)
  }

  log(`ALMA Mac Agent v${AGENT_VERSION} starting · host=${hostname()} · server=${baseUrl()}`)
  let backoff = 0

  for (;;) {
    try {
      if (existsSync(PAUSE_FILE)) {
        await sleep(POLL_INTERVAL_IDLE_MS)
        continue
      }

      const { command, paused } = await pollOnce(cfg.token)
      backoff = 0

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
  writeConfig({ token: res.json.token, deviceId: res.json.deviceId, baseUrl: baseUrl() })
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
