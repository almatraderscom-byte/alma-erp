/**
 * The one share story for Mac screenshots (screenshot-share.ts) and the
 * wrong-tool interceptor pattern that feeds it.
 *
 * Owner rule 2026-08-02: the model must not be able to pick the wrong tool —
 * and when it does, the SYSTEM absorbs the misuse. The screencapture regex
 * below is the deterministic gate for the case that fired live (the head ran
 * `screencapture` through run_mac_command and the owner got an invisible file
 * on his Desktop instead of a picture in chat).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploadMock = vi.fn(async () => ({ bucket: 'agent-files', objectPath: 'x' }))
const listMock = vi.fn(async () => [] as Array<{ name: string; size: number }>)
const deleteMock = vi.fn(async () => {})

vi.mock('@/agent/lib/storage', () => ({
  agentStorageUpload: (...a: unknown[]) => uploadMock(...(a as [])),
  agentStorageListFolder: (...a: unknown[]) => listMock(...(a as [])),
  agentStorageDelete: (...a: unknown[]) => deleteMock(...(a as [])),
}))

import { classifyScreencaptureIntent, shareScreenshot } from '../screenshot-share'

const JPEG_URI = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`

describe('shareScreenshot', () => {
  beforeEach(() => {
    uploadMock.mockClear()
    listMock.mockClear()
    deleteMock.mockClear()
  })

  it('uploads a data URI and returns the short owner-authed /files link', async () => {
    const r = await shareScreenshot(JPEG_URI, 'cmd-1', 'Mac screen')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.imageUrl).toMatch(/\/api\/assistant\/files\?path=mac-ui%2Fshot-\d+-cmd-1\.jpg&redirect=1$/)
    expect(r.imageUrl).toMatch(/^https?:\/\//) // absolute — Telegram has no origin
    expect(r.instruction).toContain('Mac screen')
    expect(uploadMock).toHaveBeenCalledTimes(1)
  })

  it('never uploads an oversized body — retryable instead', async () => {
    const big = `data:image/jpeg;base64,${Buffer.alloc(10_000_000).toString('base64')}`
    const r = await shareScreenshot(big, 'cmd-2', 'x')
    expect(r).toEqual({ ok: false, retryable: true })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('a non-image payload comes back bounded, never a megabyte', async () => {
    const r = await shareScreenshot('weird daemon output '.repeat(1000), 'cmd-3', 'x')
    expect(r.ok).toBe(false)
    if (r.ok || r.retryable) throw new Error('expected bounded fallback')
    expect(r.boundedText.length).toBeLessThanOrEqual(4_000)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('a failed upload is retryable, never the raw base64', async () => {
    uploadMock.mockRejectedValueOnce(new Error('storage down'))
    const r = await shareScreenshot(JPEG_URI, 'cmd-4', 'x')
    expect(r).toEqual({ ok: false, retryable: true })
  })
})

describe('wrong-tool interceptor pattern', () => {
  it('intercepts only zero-ambiguity simple screencapture commands', () => {
    for (const cmd of [
      'screencapture -C ~/Desktop/shot.png',
      '/usr/sbin/screencapture -x /tmp/a.jpg', // path-qualified (Codex P2)
      'FOO=1 screencapture out.png',
      '/usr/sbin/ScreenCapture -x out.jpg', // case-insensitive fs (Codex round 6)
    ]) {
      expect(classifyScreencaptureIntent(cmd)).toBe('intercept')
    }
  })

  it('wrapper and lookup forms are refused — no wrapper parser exists on purpose', () => {
    // Five review rounds of wrapper edges (options, operands, lookup modes,
    // path-qualified wrappers) proved that parser would never be sh. Refusal
    // runs nothing and captures nothing.
    for (const cmd of [
      'sudo screencapture -c',
      'env -i /usr/sbin/screencapture -x /tmp/a.jpg',
      'env -u screencapture printenv', // operand-consuming option (Codex round 5)
      '/usr/bin/env screencapture -x /tmp/a.jpg', // path-qualified wrapper (Codex round 5)
      'command -- screencapture -c',
      'command -v screencapture',
      'screencapture -l 123 out.jpg', // scoped — absorbing would WIDEN capture (Codex round 6)
      'screencapture -R 0,0,100,100 out.jpg',
      'screencapture -wx out.jpg',
    ]) {
      expect(classifyScreencaptureIntent(cmd)).toBe('refuse')
    }
  })

  it('anything compound mentioning screencapture is refused — never run, never captured', () => {
    // Running one risks the invisible file; intercepting one risks capturing
    // the screen on a command that only PRINTS the word (Codex P1 rounds 2-3:
    // escaped quotes, comments, wrapper options). No parsing arms race —
    // compound means refuse.
    for (const cmd of [
      'screencapture -x /tmp/a.png && echo done',
      'cd ~ ; screencapture out.png',
      "printf 'notes;screencapture usage'",
      'printf "notes;\\"; screencapture usage"', // escaped quote (Codex round 3)
      'echo ok # ; screencapture out.png', // comment (Codex round 3)
      'echo hi | grep screencapture',
      'grep "screencapture" docs/notes.md',
    ]) {
      expect(classifyScreencaptureIntent(cmd)).toBe('refuse')
    }
  })

  it('plain commands that merely contain the word still run', () => {
    for (const cmd of [
      'git status',
      'ls ~/Desktop',
      'cat notes/screencapture.md',
      'echo screencapture-is-a-word-in-this-string.txt',
    ]) {
      expect(classifyScreencaptureIntent(cmd)).toBe('run')
    }
  })
})
