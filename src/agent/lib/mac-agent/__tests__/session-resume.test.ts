/**
 * L5 — sessions that survive a daemon restart.
 *
 * The daemon persists resumable Claude sessions to sessions.json; a restarted
 * daemon lists them as `detached`, and the next send revives the CLI with
 * `--resume`. These tests drive the REAL sessions.mjs module against a
 * throwaway HOME (never ~/.alma-mac-agent — that hijacked the owner's live
 * daemon once) and a stand-in CLI binary, off-darwin skipped like the e2e.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const darwinOnly = platform() === 'darwin' ? describe : describe.skip

// realpath: macOS tmpdir sits behind the /var → /private/var symlink, and the
// restore path validates the RESOLVED cwd against the allowlist.
const TEST_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'alma-session-resume-')))
const CONFIG_DIR = join(TEST_HOME, '.alma-mac-agent')
const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json')
const SESSIONS_MJS = resolve(__dirname, '../../../../../mac-agent/sessions.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

darwinOnly('L5 session resume', () => {
  beforeAll(async () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    // The module reads homedir() at import — point it at the throwaway BEFORE.
    process.env.HOME = TEST_HOME
    // A stand-in "claude" that speaks the protocol's first line: the resume
    // path now WAITS for the CLI's init before trusting a write, so the fake
    // must emit one (then swallow stdin like the real thing).
    const fakeClaude = join(TEST_HOME, 'fake-claude.sh')
    writeFileSync(
      fakeClaude,
      '#!/bin/sh\necho \'{"type":"system","subtype":"init","session_id":"cli-abc","model":"fake"}\'\nexec cat > /dev/null\n',
      { mode: 0o755 },
    )
    process.env.ALMA_CLAUDE_BIN = fakeClaude
    mod = await import(pathToFileURL(SESSIONS_MJS).href)
  })

  afterAll(() => {
    try {
      mod?.stopAll?.()
    } catch {
      /* nothing running */
    }
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('loads a persisted session as detached', () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          id: 'restored-1',
          cliSessionId: 'cli-abc',
          tool: 'claude',
          cwd: TEST_HOME,
          permissionMode: 'plan',
          model: null,
          costUsd: 0.12,
          turns: 3,
          seq: 41,
          startedAt: Date.now() - 60_000,
          lastActivityAt: Date.now() - 30_000,
        },
      ]),
    )
    const n = mod.loadPersistedSessions([TEST_HOME])
    expect(n).toBe(1)

    const listed = mod.listSessions().sessions.find((s: { sessionId: string }) => s.sessionId === 'restored-1')
    expect(listed).toBeTruthy()
    expect(listed.status).toBe('detached')
    expect(listed.costUsd).toBeCloseTo(0.12, 4)
    // The event counter continues — restarting at 0 would reuse (sessionId,
    // seq) pairs the server has already stored and post-resume events would
    // be dropped as duplicates. Restore itself publishes one 'detached'
    // event, so the counter sits one past the persisted value.
    expect(listed.lastSeq).toBe(42)
    const read = mod.readSession('restored-1', 0)
    expect(read.events.map((e: { kind: string }) => e.kind)).toContain('detached')
  })

  it('a persisted cwd outside the CURRENT allowlist is not restored', () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          id: 'outside-1',
          cliSessionId: 'cli-out',
          tool: 'claude',
          cwd: '/tmp',
          permissionMode: 'bypass',
          startedAt: Date.now() - 60_000,
          lastActivityAt: Date.now() - 30_000,
        },
      ]),
    )
    expect(mod.loadPersistedSessions([TEST_HOME])).toBe(0)
  })

  it('read reports detached honestly, not session_not_found', () => {
    const read = mod.readSession('restored-1', 0)
    expect(read.ok).toBe(true)
    expect(read.status).toBe('detached')
  })

  it('send revives a detached session with --resume and delivers the text', async () => {
    const sent = await mod.sendToSession('restored-1', 'continue please')
    expect(sent.ok).toBe(true)

    const read = mod.readSession('restored-1', 0)
    expect(read.status).toBe('working')
    const kinds = read.events.map((e: { kind: string }) => e.kind)
    expect(kinds).toContain('resumed')
    expect(kinds).toContain('sent')
  })

  it('a stale persisted session (>24h) is not restored', () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          id: 'ancient-1',
          cliSessionId: 'cli-old',
          tool: 'claude',
          cwd: TEST_HOME,
          permissionMode: 'plan',
          startedAt: Date.now() - 48 * 3600_000,
          lastActivityAt: Date.now() - 30 * 3600_000,
        },
      ]),
    )
    expect(mod.loadPersistedSessions([TEST_HOME])).toBe(0)
  })

  it('an ended session drops out of the persisted file', () => {
    mod.stopSession('restored-1')
    expect(existsSync(SESSIONS_FILE)).toBe(true)
    const rows = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
    expect(rows.find((r: { id: string }) => r.id === 'restored-1')).toBeUndefined()
  })
})
