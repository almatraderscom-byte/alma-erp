/**
 * The daemon's refusals are the last thing standing between a bad command and the
 * owner's laptop, so they are tested against the REAL daemon process — not a
 * stub, not the classifier in isolation.
 *
 * A stand-in bus hands the daemon a scripted queue that deliberately includes
 * commands the server should never have sent (a RED one, an unapproved AMBER one,
 * a path outside the allowlist). The daemon must refuse those on its own
 * judgement, which is exactly the property that makes a server-side compromise
 * survivable.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const AGENT = resolve(__dirname, '../../../../../mac-agent/agent.mjs')
const CONFIG_DIR = join(homedir(), '.alma-mac-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const TOKEN = 'e2e-test-token'
const APPROVED_MARKER = join(tmpdir(), 'alma-mac-e2e-approved.txt')
const REFUSED_MARKER = join(tmpdir(), 'alma-mac-e2e-refused.txt')

interface Result {
  commandId: string
  ok: boolean
  exitCode: number | null
  stdout: string
  error: string | null
}

const QUEUE = [
  { id: 'ping', action: 'ping', params: {} },
  { id: 'green', action: 'run_command', params: { command: 'node -v', cwd: '~/alma-erp' } },
  { id: 'red', action: 'run_command', params: { command: 'sudo rm -rf /', cwd: '~/alma-erp' } },
  {
    id: 'amber_unapproved',
    action: 'run_command',
    params: { command: `touch ${REFUSED_MARKER}`, cwd: '~/alma-erp' },
  },
  {
    id: 'amber_approved',
    action: 'run_command',
    params: { command: `touch ${APPROVED_MARKER}`, cwd: '~/alma-erp', approved: true },
  },
  { id: 'bad_cwd', action: 'run_command', params: { command: 'ls', cwd: '~/.ssh' } },
  {
    id: 'timeout',
    action: 'run_command',
    params: { command: 'sleep 30', cwd: '~/alma-erp', approved: true, timeoutMs: 1_500 },
  },
  // Codex review: only run_command had a daemon-side backstop, so a bus bug could
  // have opened a fully unattended CLI session with no card ever shown.
  {
    id: 'bypass_unapproved',
    action: 'session_open',
    params: { tool: 'claude', cwd: '~/alma-erp', permissionMode: 'bypass' },
  },
]

let server: Server | undefined
let daemon: ChildProcess | undefined
let savedConfig: string | null = null

function startBus(results: Map<string, Result>, done: () => void): Promise<number> {
  return new Promise((resolvePort) => {
    const queue = [...QUEUE]
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('{}')
        return
      }
      if (req.url?.endsWith('/poll')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ command: queue.shift() ?? null }))
        return
      }
      if (req.url?.endsWith('/result')) {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          const parsed = JSON.parse(body) as Result
          results.set(parsed.commandId, parsed)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          if (results.size === QUEUE.length) done()
        })
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, () => {
      const addr = server!.address()
      resolvePort(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

afterAll(() => {
  daemon?.kill('SIGKILL')
  server?.close()
  // Put the owner's real pairing config back exactly as we found it.
  if (savedConfig !== null) writeFileSync(CONFIG_FILE, savedConfig, { mode: 0o600 })
  else rmSync(CONFIG_FILE, { force: true })
  rmSync(APPROVED_MARKER, { force: true })
  rmSync(REFUSED_MARKER, { force: true })
})

describe('mac daemon end-to-end (real process, stand-in bus)', () => {
  it(
    'obeys its own policy even when the bus asks for something it should not',
    async () => {
      const results = new Map<string, Result>()
      let finish: () => void = () => {}
      const allIn = new Promise<void>((r) => (finish = r))
      const port = await startBus(results, finish)

      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
      try {
        savedConfig = existsSync(CONFIG_FILE) ? require('fs').readFileSync(CONFIG_FILE, 'utf8') : null
      } catch {
        savedConfig = null
      }
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ token: TOKEN, deviceId: 'e2e', baseUrl: `http://127.0.0.1:${port}` }),
        { mode: 0o600 },
      )

      rmSync(APPROVED_MARKER, { force: true })
      rmSync(REFUSED_MARKER, { force: true })

      daemon = spawn(process.execPath, [AGENT, 'run'], {
        env: {
          ...process.env,
          ALMA_BASE_URL: `http://127.0.0.1:${port}`,
          ALMA_POLL_MS: '60',
          ALMA_POLL_IDLE_MS: '60',
        },
        stdio: 'ignore',
      })

      await Promise.race([
        allIn,
        new Promise((_, reject) => setTimeout(() => reject(new Error('daemon did not finish the queue')), 25_000)),
      ])

      // Reads run.
      expect(results.get('ping')?.ok).toBe(true)
      expect(results.get('green')?.ok).toBe(true)
      expect(results.get('green')?.stdout).toMatch(/^v\d+/)

      // The bus asked for `sudo rm -rf /`. The daemon refuses on its own.
      expect(results.get('red')?.ok).toBe(false)
      expect(results.get('red')?.error).toContain('refused_by_daemon:sudo')

      // A state-changing command with no approval attached does not run — and the
      // filesystem proves it, not just the return value.
      expect(results.get('amber_unapproved')?.ok).toBe(false)
      expect(results.get('amber_unapproved')?.error).toContain('missing_approval')
      expect(existsSync(REFUSED_MARKER)).toBe(false)

      // The same command WITH approval does run.
      expect(results.get('amber_approved')?.ok).toBe(true)
      expect(existsSync(APPROVED_MARKER)).toBe(true)

      // Outside the allowlisted folders, nothing runs at all.
      expect(results.get('bad_cwd')?.ok).toBe(false)
      expect(results.get('bad_cwd')?.error).toContain('cwd_not_allowed')

      // A hung command is killed at its deadline instead of holding the queue.
      expect(results.get('timeout')?.ok).toBe(false)
      expect(results.get('timeout')?.error).toContain('timeout')

      // An unattended session with no approval marker never starts, whatever the
      // bus claims.
      expect(results.get('bypass_unapproved')?.ok).toBe(false)
      expect(results.get('bypass_unapproved')?.error).toContain('bypass_requires_approval')
    },
    40_000,
  )
})
