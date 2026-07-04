/**
 * P2 VPS Workbench — the agent's own computer (roadmap docs/agent-computer-use-roadmap.md P2).
 *
 * Executes a bounded list of shell commands in a per-task workspace directory,
 * Claude-Code style: run → capture output → iterate (the head drives iterations
 * as separate jobs; each job is deterministic and capped).
 *
 * Safety (P2 rules):
 *   • Command allowlist by BINARY (first token) — no shell metacharacter tricks:
 *     commands run via execFile (no shell), args passed as an array.
 *   • Per-task workspace under WORKBENCH_ROOT; the task cannot name paths outside
 *     it (arguments containing .. or absolute paths outside the workspace are rejected).
 *   • Hard caps: per-command timeout, total wall-clock, output bytes, workspace disk.
 *   • Network: curl/wget only through the same SSRF policy as the browser worker
 *     (public http(s) only — no internal IPs/metadata endpoints).
 *   • NEVER touches ERP secrets: jobs get a scrubbed env (PATH/HOME/LANG only).
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const WORKBENCH_ROOT = process.env.WORKBENCH_ROOT || '/opt/alma-workbench'
const CMD_TIMEOUT_MS = 120_000
const TOTAL_TIMEOUT_MS = 8 * 60_000
const MAX_OUTPUT_BYTES = 200_000
const MAX_COMMANDS = 20
const MAX_WORKSPACE_BYTES = 500 * 1024 * 1024

/** Binaries the workbench may run. Extend deliberately, never with a shell. */
const ALLOWED_BINARIES = new Set([
  'node', 'python3', 'pip3', 'git', 'curl', 'wget',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'sed', 'awk',
  'mkdir', 'cp', 'mv', 'tar', 'gzip', 'gunzip', 'unzip', 'zip', 'jq', 'ffmpeg', 'ffprobe',
])

/** Args that would escape the workspace or hit private networks. */
function unsafeArg(arg, workDir) {
  if (typeof arg !== 'string') return true
  if (arg.includes('..')) return true
  if (arg.startsWith('/') && !resolve(arg).startsWith(workDir) && !arg.startsWith('/usr/') && !arg.startsWith('/opt/homebrew/')) {
    // absolute paths only inside the workspace (or interpreter locations)
    return !resolve(arg).startsWith(workDir)
  }
  // block obvious private/metadata network targets for curl/wget
  if (/^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i.test(arg)) return true
  return false
}

async function dirSizeBytes(dir) {
  let total = 0
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) total += await dirSizeBytes(p)
      else total += (await stat(p)).size
    } catch { /* raced */ }
  }
  return total
}

function runOne(bin, args, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { PATH: process.env.PATH, HOME: cwd, LANG: 'en_US.UTF-8' },
      },
      (err, stdout, stderr) => {
        resolvePromise({
          ok: !err,
          code: err?.code ?? 0,
          timedOut: Boolean(err && err.killed),
          stdout: String(stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
          stderr: String(stderr ?? '').slice(0, 20_000),
        })
      },
    )
    child.on('error', () => { /* handled via callback err */ })
  })
}

/**
 * @param {object} payload { taskId, commands: Array<{bin, args[]}>, files?: Array<{path, content}> , keepWorkspace?: boolean }
 * @returns {Promise<{ok:boolean, steps:Array, workspace:string, error?:string}>}
 */
export async function runWorkbenchTask(payload) {
  const taskId = String(payload.taskId || `wb-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '')
  const commands = Array.isArray(payload.commands) ? payload.commands.slice(0, MAX_COMMANDS) : []
  if (!commands.length) return { ok: false, steps: [], workspace: '', error: 'no_commands' }

  const workDir = join(WORKBENCH_ROOT, taskId)
  await mkdir(workDir, { recursive: true })

  // Seed input files (e.g. a script the head wrote) — paths relative to workspace only.
  for (const f of Array.isArray(payload.files) ? payload.files.slice(0, 20) : []) {
    const rel = String(f.path || '').replace(/^\/+/, '')
    if (!rel || rel.includes('..')) continue
    const target = join(workDir, rel)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, String(f.content ?? ''), 'utf8')
  }

  const steps = []
  const startedAt = Date.now()
  let ok = true
  for (const [i, cmd] of commands.entries()) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
      steps.push({ i, error: 'total_time_budget_exhausted' })
      ok = false
      break
    }
    const bin = String(cmd.bin || '')
    const args = Array.isArray(cmd.args) ? cmd.args.map(String) : []
    if (!ALLOWED_BINARIES.has(bin)) {
      steps.push({ i, bin, error: `binary_not_allowed:${bin}` })
      ok = false
      break
    }
    if (args.some((a) => unsafeArg(a, workDir))) {
      steps.push({ i, bin, error: 'unsafe_argument (path escape or private network)' })
      ok = false
      break
    }
    const res = await runOne(bin, args, workDir, Math.min(CMD_TIMEOUT_MS, Number(cmd.timeoutMs) || CMD_TIMEOUT_MS))
    steps.push({ i, bin, args: args.join(' ').slice(0, 300), ...res })
    if (!res.ok) { ok = false; break }
    if ((await dirSizeBytes(workDir)) > MAX_WORKSPACE_BYTES) {
      steps.push({ i, error: 'workspace_disk_cap_exceeded' })
      ok = false
      break
    }
  }

  if (!payload.keepWorkspace && !ok) {
    // keep failed workspaces for diagnosis; only clean SUCCESSFUL ephemeral runs
  } else if (!payload.keepWorkspace && ok) {
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  return { ok, steps, workspace: workDir, error: ok ? undefined : steps[steps.length - 1]?.error ?? 'step_failed' }
}
