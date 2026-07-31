/**
 * M2 — driving Claude Code / Codex sessions on the owner's Mac.
 *
 * The owner does most of his work in the Claude and Codex apps. What he asked for
 * is to keep doing that when he is not at the desk: "open a session, give it this
 * task, watch it, and when it needs me, ask me."
 *
 * We drive the CLIs, NOT the app windows. Clicking around a GUI breaks the moment
 * a window moves, and it cannot be observed reliably. `claude -p` with
 * stream-json in and out gives us the same session — creatable, resumable, and
 * emitting a structured event for every assistant turn and tool call — which is
 * exactly what "observe it and tell me when it needs something" requires.
 *
 * Permission posture (the part that matters):
 *   plan        — read-only; it can look and propose, nothing changes. Default.
 *   acceptEdits — file edits go through, other tools still ask.
 *   bypass      — everything runs unattended. NEVER the default; the ALMA side
 *                 makes this one an owner approval card before the session opens.
 *
 * A session that ends, errors, or goes quiet leaves a readable last state, so the
 * owner is never left wondering whether his task is still running.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = homedir()

/** Live sessions, keyed by our own id (not the CLI's). */
const sessions = new Map()

/** How many events we keep per session before dropping the oldest. */
const MAX_EVENTS = 400
/** A session with no activity for this long is considered idle-finished. */
const IDLE_MS = 5 * 60 * 1000

const PERMISSION_MODES = {
  plan: 'plan',
  acceptEdits: 'acceptEdits',
  bypass: 'bypassPermissions',
}

function expandHome(p) {
  if (!p) return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return join(HOME, p.slice(2))
  return p
}

/**
 * Where a session may run. Same allowlist idea as the shell policy: a CLI agent
 * pointed at the home directory is a CLI agent with the run of the machine.
 */
function resolveCwd(requested, allowedDirs) {
  const fallback = join(HOME, 'alma-erp')
  const abs = requested ? expandHome(String(requested)) : fallback
  if (abs.includes('..')) return null
  const inside = allowedDirs.some((d) => abs === d || abs.startsWith(`${d}/`))
  if (!inside) return null
  return existsSync(abs) ? abs : null
}

function pushEvent(session, event) {
  session.seq += 1
  session.events.push({ seq: session.seq, at: new Date().toISOString(), ...event })
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS)
  session.lastActivityAt = Date.now()
}

/**
 * Turn one stream-json line into the compact event the owner's assistant will
 * summarise. We keep assistant text and tool NAMES; tool inputs and outputs are
 * deliberately dropped — they are large, and they are the most likely place for
 * untrusted file content to end up in the head's context.
 */
function ingestLine(session, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  if (msg.type === 'system' && msg.subtype === 'init') {
    session.cliSessionId = msg.session_id ?? null
    session.model = msg.model ?? null
    session.status = 'working'
    pushEvent(session, { kind: 'started', model: msg.model ?? null, cliSessionId: msg.session_id ?? null })
    return
  }

  if (msg.type === 'assistant') {
    const content = msg.message?.content ?? []
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
    const tools = content.filter((c) => c.type === 'tool_use').map((c) => c.name)

    // The CLI reports auth failure as an ordinary assistant message; treat it as
    // the hard error it is instead of relaying "Please run /login" as an answer.
    if (msg.error === 'authentication_failed' || /Not logged in/i.test(texts)) {
      session.status = 'error'
      session.error = 'not_logged_in'
      pushEvent(session, {
        kind: 'error',
        error: 'not_logged_in',
        messageBn:
          'Claude CLI-তে লগইন নেই, Boss। Mac-এ একবার Terminal খুলে `claude` লিখে `/login` করুন — একবার করলেই পরে সব চলবে।',
      })
      return
    }

    if (texts) pushEvent(session, { kind: 'text', text: texts.slice(0, 4_000) })
    for (const name of tools) pushEvent(session, { kind: 'tool', tool: name })
    return
  }

  if (msg.type === 'result') {
    session.status = msg.is_error ? 'error' : 'idle'
    session.costUsd = (session.costUsd ?? 0) + (msg.total_cost_usd ?? 0)
    session.turns = msg.num_turns ?? session.turns
    pushEvent(session, {
      kind: 'turn_done',
      isError: Boolean(msg.is_error),
      result: typeof msg.result === 'string' ? msg.result.slice(0, 4_000) : null,
      costUsd: msg.total_cost_usd ?? 0,
    })
  }
}

/** Build the CLI argv for a session. */
function buildArgs(tool, { permissionMode, model, cliSessionId, resume, codexPrompt }) {
  if (tool === 'codex') {
    // `codex exec` is ONE-SHOT: the prompt is an argument, stdout is JSONL, and
    // stdin is not an interactive channel. Writing Claude's stream-JSON records
    // into it made a Codex session hang forever waiting for EOF (Codex review
    // round 2). One task per session; session_send is rejected below.
    return ['exec', '--json', String(codexPrompt ?? '')]
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', PERMISSION_MODES[permissionMode] ?? 'plan',
  ]
  if (model) args.push('--model', model)
  if (resume && cliSessionId) args.push('--resume', cliSessionId)
  else if (cliSessionId) args.push('--session-id', cliSessionId)
  return args
}

function binaryFor(tool) {
  if (tool === 'codex') return process.env.ALMA_CODEX_BIN || 'codex'
  return process.env.ALMA_CLAUDE_BIN || join(HOME, '.local/bin/claude')
}

export function openSession(params, allowedDirs) {
  const tool = params.tool === 'codex' ? 'codex' : 'claude'
  const cwd = resolveCwd(params.cwd, allowedDirs)
  if (!cwd) {
    return { ok: false, error: 'cwd_not_allowed: অনুমোদিত ফোল্ডারের বাইরে বা ফোল্ডারটি নেই।' }
  }

  const bin = binaryFor(tool)
  if (tool === 'codex' && !existsSync(bin) && !/^[^/]+$/.test(bin)) {
    return { ok: false, error: 'codex_not_installed' }
  }

  const id = randomUUID()
  const cliSessionId = randomUUID()
  const permissionMode = params.permissionMode ?? 'plan'

  const session = {
    id,
    tool,
    cwd,
    permissionMode,
    cliSessionId,
    status: 'starting',
    events: [],
    seq: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    costUsd: 0,
    turns: 0,
    error: null,
    stderr: '',
  }

  let child
  try {
    child = spawn(bin, buildArgs(tool, {
      permissionMode,
      model: params.model,
      cliSessionId,
      codexPrompt: params.task,
    }), {
      cwd,
      env: { ...process.env, ALMA_MAC_AGENT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    return { ok: false, error: `spawn_failed: ${err?.message ?? err}` }
  }

  session.child = child

  let buffer = ''
  child.stdout.on('data', (d) => {
    buffer += d.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) ingestLine(session, line)
    }
  })
  child.stderr.on('data', (d) => {
    if (session.stderr.length < 8_000) session.stderr += d.toString()
  })
  child.on('error', (err) => {
    session.status = 'error'
    session.error = String(err?.message ?? err)
    pushEvent(session, { kind: 'error', error: session.error })
  })
  child.on('close', (code) => {
    session.status = session.status === 'error' ? 'error' : 'ended'
    session.exitCode = code
    pushEvent(session, { kind: 'ended', exitCode: code })
  })

  sessions.set(id, session)

  // Claude takes the first task over stdin; Codex already received it as an
  // argument (one-shot), so sending it again would corrupt the run.
  if (params.task && tool !== 'codex') sendToSession(id, String(params.task))

  return { ok: true, sessionId: id, cliSessionId, tool, cwd, permissionMode, oneShot: tool === 'codex' }
}

export function sendToSession(sessionId, text) {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  if (session.tool === 'codex') {
    return { ok: false, error: 'codex_is_one_shot: Codex সেশনে পরে আর নির্দেশ পাঠানো যায় না — নতুন সেশন খুলুন।' }
  }
  if (session.status === 'ended') return { ok: false, error: 'session_ended' }
  if (!session.child?.stdin?.writable) return { ok: false, error: 'session_not_writable' }

  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
  }
  session.child.stdin.write(`${JSON.stringify(payload)}\n`)
  session.status = 'working'
  pushEvent(session, { kind: 'sent', text: String(text).slice(0, 1_000) })
  return { ok: true, sessionId }
}

export function readSession(sessionId, sinceSeq = 0) {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }

  const idle = Date.now() - session.lastActivityAt > IDLE_MS
  const events = session.events.filter((e) => e.seq > Number(sinceSeq || 0))

  return {
    ok: true,
    sessionId,
    tool: session.tool,
    cwd: session.cwd,
    status: session.status === 'working' && idle ? 'stalled' : session.status,
    permissionMode: session.permissionMode,
    model: session.model ?? null,
    costUsd: Number(session.costUsd.toFixed(4)),
    turns: session.turns,
    error: session.error,
    stderrTail: session.stderr.slice(-600) || null,
    events,
    lastSeq: session.seq,
  }
}

export function stopSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  try {
    session.child?.stdin?.end()
    session.child?.kill('SIGTERM')
    // A CLI mid-tool can ignore SIGTERM; make sure it actually goes.
    setTimeout(() => {
      try {
        session.child?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 3_000)
  } catch {
    /* nothing to stop */
  }
  session.status = 'ended'
  return { ok: true, sessionId }
}

export function listSessions() {
  return {
    ok: true,
    sessions: [...sessions.values()].map((s) => ({
      sessionId: s.id,
      tool: s.tool,
      cwd: s.cwd,
      status: s.status,
      permissionMode: s.permissionMode,
      startedAt: new Date(s.startedAt).toISOString(),
      lastActivityAt: new Date(s.lastActivityAt).toISOString(),
      costUsd: Number(s.costUsd.toFixed(4)),
      turns: s.turns,
      lastSeq: s.seq,
    })),
  }
}

/**
 * Take every child down with us.
 *
 * The session map is in memory, so a launchd restart used to leave orphaned
 * `claude` children running while the restarted daemon answered
 * `session_not_found` for every read and stop (Codex review round 2 — and the
 * likely cause of a live send failure on 2026-08-01). We cannot recover the
 * stream after a restart, so the honest thing is to leave nothing behind.
 */
export function installExitHandlers() {
  const shutdown = () => {
    for (const s of sessions.values()) {
      try {
        if (s.child?.pid) process.kill(-s.child.pid, 'SIGKILL')
      } catch {
        try {
          s.child?.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }
  process.once('exit', shutdown)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => {
      shutdown()
      process.exit(0)
    })
  }
}

/** Kill everything — used by the owner's STOP. */
export function stopAll() {
  let n = 0
  for (const id of sessions.keys()) {
    stopSession(id)
    n += 1
  }
  return n
}

/**
 * Can we actually open a session right now? Checked BEFORE the owner asks for
 * one, because the failure it catches is invisible otherwise: he is logged into
 * the Claude *app*, but the standalone CLI keeps its own account login, and an
 * un-logged-in CLI reports that as an ordinary chat reply ("Please run /login")
 * rather than as an error. Verified on this Mac 2026-07-31: the keychain entry
 * holds only MCP OAuth, no account token.
 */
export function cliHealth() {
  const claudeBin = binaryFor('claude')
  const claudeInstalled = existsSync(claudeBin)
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())

  return {
    claude: {
      installed: claudeInstalled,
      path: claudeBin,
      // The CLI takes either an account login (`claude` → /login, stored in the
      // keychain) or ANTHROPIC_API_KEY from the environment. We can see the key;
      // the login itself only reveals itself when a session runs, so the session
      // driver still reports not_logged_in if it turns out to be missing.
      apiKeyInEnv: hasApiKey,
    },
    codex: { installed: existsSync(binaryFor('codex')) || Boolean(process.env.ALMA_CODEX_BIN) },
  }
}

/** Wire the session verbs into the daemon's command dispatch. */
export function registerSessionHandlers(extraHandlers, allowedDirs) {
  installExitHandlers()
  const wrap = (fn) => async (params) => {
    const out = fn(params)
    return out.ok
      ? { ok: true, exitCode: 0, stdout: JSON.stringify(out) }
      : { ok: false, exitCode: null, error: out.error }
  }

  extraHandlers.set('session_open', wrap((p) => openSession(p, allowedDirs)))
  extraHandlers.set('session_send', wrap((p) => sendToSession(String(p.sessionId), String(p.text ?? ''))))
  extraHandlers.set('session_read', wrap((p) => readSession(String(p.sessionId), Number(p.sinceSeq ?? 0))))
  extraHandlers.set('session_stop', wrap((p) => stopSession(String(p.sessionId))))
  extraHandlers.set('session_list', wrap(() => listSessions()))
}
