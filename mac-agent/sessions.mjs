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
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = homedir()

/** Live sessions, keyed by our own id (not the CLI's). */
const sessions = new Map()

/**
 * L5 — surviving a daemon restart.
 *
 * The event stream cannot survive (the child dies with us — the honest exit
 * handler below), but the SESSION can: the Claude CLI supports
 * `--resume <cli-session-id>`, and we already hold that id. So we persist the
 * little that matters, and a restarted daemon lists those sessions as
 * `detached`. The next `session_send` respawns the CLI with `--resume` and the
 * conversation continues where it left off; `session_read` says `detached`
 * honestly instead of `session_not_found`.
 *
 * Codex is one-shot and cannot be resumed; its sessions are not persisted.
 */
const SESSIONS_FILE = join(HOME, '.alma-mac-agent', 'sessions.json')
/** A detached session older than this is history, not something to offer resume for. */
const DETACHED_MAX_AGE_MS = 24 * 60 * 60 * 1000

function persistSessions() {
  try {
    const dir = join(HOME, '.alma-mac-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const rows = [...sessions.values()]
      // Only what can actually come back: Claude sessions that haven't ended.
      .filter((s) => s.tool === 'claude' && s.status !== 'ended' && s.status !== 'error')
      .map((s) => ({
        id: s.id,
        cliSessionId: s.cliSessionId,
        tool: s.tool,
        cwd: s.cwd,
        permissionMode: s.permissionMode,
        model: s.model ?? null,
        costUsd: s.costUsd ?? 0,
        turns: s.turns ?? 0,
        // The event counter must survive too: a restored session that restarts
        // at seq 0 reuses (sessionId, seq) pairs the server has already seen,
        // and its post-resume events would be dropped as retry duplicates
        // (Codex on the L5 PR).
        seq: s.seq ?? 0,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
      }))
    // Atomic: a kill mid-write must never leave a truncated sessions.json —
    // the next startup would parse-fail and silently restore NOTHING,
    // defeating the whole feature (Codex, L5 round 4).
    const tmp = `${SESSIONS_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 })
    renameSync(tmp, SESSIONS_FILE)
  } catch {
    /* persistence is best-effort; a failed write must never break a session */
  }
}

/**
 * Load what the previous daemon run left behind, as detached sessions.
 *
 * The saved cwd is re-validated against the CURRENT allowlist — a project
 * removed from the allowlist while the daemon was down must not stay remotely
 * drivable (with its persisted permission mode) just because it was saved
 * before the change (Codex on the L5 PR).
 */
export function loadPersistedSessions(allowedDirs = []) {
  try {
    if (!existsSync(SESSIONS_FILE)) return 0
    const rows = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
    let n = 0
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.id || !r?.cliSessionId) continue
      if (Date.now() - (r.lastActivityAt ?? 0) > DETACHED_MAX_AGE_MS) continue
      if (sessions.has(r.id)) continue
      // The REAL path decides, not the text: a symlink dropped in place while
      // the daemon was down would pass a textual prefix check and hand the
      // session's (possibly bypass) permissions to a directory outside the
      // allowlist (Codex, L5 round 5).
      let cwd
      try {
        cwd = realpathSync(String(r.cwd ?? ''))
      } catch {
        continue // gone or unresolvable — nothing to restore into
      }
      const inside =
        !cwd.includes('..') && allowedDirs.some((d) => cwd === d || cwd.startsWith(`${d}/`))
      if (!inside) continue
      const seq = Number.isFinite(Number(r.seq)) ? Number(r.seq) : 0
      sessions.set(r.id, {
        id: r.id,
        tool: 'claude',
        cwd,
        permissionMode: r.permissionMode ?? 'plan',
        cliSessionId: r.cliSessionId,
        model: r.model ?? null,
        status: 'detached',
        events: [],
        // Continue the numbering: seq 0 would reuse server-side (sessionId,
        // seq) pairs and post-resume events would vanish as "duplicates".
        seq,
        pushedSeq: seq,
        startedAt: r.startedAt ?? Date.now(),
        lastActivityAt: r.lastActivityAt ?? Date.now(),
        costUsd: r.costUsd ?? 0,
        turns: r.turns ?? 0,
        error: null,
        stderr: '',
        child: null,
      })
      // Tell the feed the truth: without this, the session's last streamed
      // event (text/tool) kept showing a live "working" pulse for the rest of
      // the window although its child died with the old daemon (Codex, L5
      // round 2). The event also rides the restored counter, proving the
      // seq continuation end-to-end.
      const restored = sessions.get(r.id)
      pushEvent(restored, { kind: 'detached' })
      // …but restoration is not ACTIVITY: pushEvent's touch would renew the
      // 24h expiry on every restart, keeping an old approved bypass session
      // alive forever (Codex, L5 round 4). Keep the original clock.
      restored.lastActivityAt = r.lastActivityAt ?? Date.now()
      persistSessions()
      n += 1
    }
    return n
  } catch {
    return 0
  }
}

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
  // EVERY advance hits disk: a restart mid-turn with a stale saved counter
  // would reuse already-stored (sessionId, seq) numbers, and the resumed
  // session's events would vanish as server-side "duplicates" until the
  // counter caught up (Codex, L5 round 2). The file is tiny; the write is
  // nothing next to the CLI turn that produced the event.
  persistSessions()
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
    // The resume path waits on this before trusting a write: a child that
    // rejects startup never sends init.
    session.cliReady = true
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
    persistSessions() // cost/turn totals survive a restart
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

/** Wire a spawned CLI child into a session — shared by open and resume. */
function attachChild(session, child) {
  session.child = child

  // A rejected resume (missing saved conversation, auth failure) closes the
  // child right after spawn; the next stdin write then raises EPIPE, and with
  // no handler that TERMINATED THE DAEMON (Codex, L5 round 2). stdin errors
  // mark the session, never the process.
  child.stdin?.on?.('error', (err) => {
    session.status = 'error'
    session.error = `stdin: ${err?.message ?? err}`
    pushEvent(session, { kind: 'error', error: session.error })
  })

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
    // A detached-and-resumed session's OLD child closing must not clobber the
    // fresh one's status.
    if (session.child !== child) return
    session.status = session.status === 'error' ? 'error' : 'ended'
    session.exitCode = code
    pushEvent(session, { kind: 'ended', exitCode: code })
    persistSessions()
  })
}

/**
 * L5 — bring a detached session back to life with `--resume`. The CLI reloads
 * the full conversation from its own store; our event buffer starts fresh
 * (the old events are gone with the old process, and we say so honestly).
 */
function respawnDetached(session) {
  const bin = binaryFor('claude')
  let child
  try {
    child = spawn(bin, buildArgs('claude', {
      permissionMode: session.permissionMode,
      model: session.model,
      cliSessionId: session.cliSessionId,
      resume: true,
    }), {
      cwd: session.cwd,
      env: { ...process.env, ALMA_MAC_AGENT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    return { ok: false, error: `resume_spawn_failed: ${err?.message ?? err}` }
  }
  // A missing/non-executable binary surfaces ASYNCHRONOUSLY (ENOENT via the
  // 'error' event), with spawn() happily returning a pid-less child — and the
  // owner's instruction would be "delivered" into nothing (Codex on the L5
  // PR). No pid = it never started.
  if (!child.pid) {
    return { ok: false, error: 'resume_spawn_failed: claude binary missing or not executable' }
  }
  session.status = 'working'
  session.error = null
  session.cliReady = false
  attachChild(session, child)
  pushEvent(session, { kind: 'resumed', cliSessionId: session.cliSessionId })
  persistSessions()
  return { ok: true }
}

/**
 * A resumed CLI proves itself with its init line; one that rejects the saved
 * conversation (or auth) reads stdin and exits WITHOUT it — and a write
 * callback alone can succeed against such a child (Codex, L5 round 5). Wait
 * for init, an exit, or the deadline before trusting the pipe.
 */
function awaitCliReady(session, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (session.cliReady) {
        clearInterval(timer)
        resolve(true)
      } else if (session.status === 'ended' || session.status === 'error') {
        clearInterval(timer)
        resolve(false)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
  })
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

  attachChild(session, child)
  sessions.set(id, session)
  persistSessions()

  // Claude takes the first task over stdin; Codex already received it as an
  // argument (one-shot), so sending it again would corrupt the run.
  // Fire-and-observe: a failed first write surfaces through the session's own
  // error state/events, and openSession's contract stays synchronous.
  if (params.task && tool !== 'codex') void sendToSession(id, String(params.task))

  return { ok: true, sessionId: id, cliSessionId, tool, cwd, permissionMode, oneShot: tool === 'codex' }
}

export async function sendToSession(sessionId, text) {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  if (session.tool === 'codex') {
    return { ok: false, error: 'codex_is_one_shot: Codex সেশনে পরে আর নির্দেশ পাঠানো যায় না — নতুন সেশন খুলুন।' }
  }
  if (session.status === 'ended') return { ok: false, error: 'session_ended' }
  // L5: a daemon restart detached this session — bring it back with --resume,
  // wait for the CLI to prove it accepted the resume (its init line), THEN
  // deliver the text into the revived conversation.
  if (session.status === 'detached') {
    const revived = respawnDetached(session)
    if (!revived.ok) return revived
    const ready = await awaitCliReady(session)
    if (!ready) {
      return { ok: false, error: 'resume_failed: সেশনটা resume নেয়নি — নতুন সেশন খুলুন।' }
    }
  }
  if (!session.child?.stdin?.writable) return { ok: false, error: 'session_not_writable' }

  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
  }
  // The write must be CONFIRMED before we claim delivery: a child that dies
  // during resume startup fails the write asynchronously (EPIPE via the
  // completion callback), and returning ok before that lost the owner's
  // instruction silently (Codex, L5 round 3). A slow drain (backpressure) is
  // not a failure — the short timer keeps a stalled pipe from hanging the
  // command queue; genuine failures call back well within it.
  const wrote = await new Promise((resolve) => {
    let settled = false
    const done = (ok, err) => {
      if (!settled) {
        settled = true
        resolve({ ok, err })
      }
    }
    try {
      session.child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => done(!err, err))
    } catch (err) {
      done(false, err)
    }
    setTimeout(() => done(true, null), 1_500)
  })
  if (!wrote.ok) {
    session.status = 'error'
    session.error = `stdin: ${wrote.err?.message ?? wrote.err}`
    return { ok: false, error: 'session_write_failed: সেশনটা resume নেয়নি — নতুন সেশন খুলুন।' }
  }
  session.status = 'working'
  pushEvent(session, { kind: 'sent', text: String(text).slice(0, 1_000) })
  persistSessions()
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
  persistSessions() // an ended session must not offer resume after restart
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
    // Last chance to save the true counters before the children die with us.
    persistSessions()
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

/**
 * L4 — events not yet pushed to the server's live feed.
 *
 * Each session remembers the highest seq the server has ACCEPTED (`pushedSeq`).
 * The collector returns everything newer; the caller advances the mark only
 * after a 2xx, so a dropped POST simply re-sends the same batch and the
 * server's (sessionId, seq) unique key keeps the feed duplicate-free.
 */
const PUSH_BATCH_MAX = 50

export function collectUnpushedEvents() {
  const batches = []
  for (const s of sessions.values()) {
    const pushed = s.pushedSeq ?? 0
    const fresh = s.events.filter((e) => e.seq > pushed).slice(0, PUSH_BATCH_MAX)
    if (fresh.length === 0) continue
    batches.push({
      sessionId: s.id,
      tool: s.tool,
      events: fresh,
      lastSeq: fresh[fresh.length - 1].seq,
    })
  }
  return batches
}

export function markEventsPushed(sessionId, lastSeq) {
  const s = sessions.get(sessionId)
  if (s && Number(lastSeq) > (s.pushedSeq ?? 0)) s.pushedSeq = Number(lastSeq)
}

/** Wire the session verbs into the daemon's command dispatch. */
export function registerSessionHandlers(extraHandlers, allowedDirs) {
  installExitHandlers()
  loadPersistedSessions(allowedDirs)
  const wrap = (fn) => async (params) => {
    // session_send is async now (it awaits the stdin write's completion);
    // await tolerates the still-synchronous verbs too.
    const out = await fn(params)
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
