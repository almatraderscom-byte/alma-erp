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

import { isScreenshotShellCommand, shareScreenshot } from '../screenshot-share'

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
  it('catches the shell screenshot shapes the head actually produces', () => {
    for (const cmd of [
      'screencapture -C ~/Desktop/shot.png',
      'screencapture -x /tmp/a.png && echo done',
      'cd ~ ; screencapture out.png',
      '/usr/sbin/screencapture -x /tmp/a.jpg', // path-qualified (Codex P2)
      'sudo screencapture -c',
      'FOO=1 screencapture out.png',
    ]) {
      expect(isScreenshotShellCommand(cmd)).toBe(true)
    }
  })

  it('leaves ordinary commands alone — including quoted data (Codex P1)', () => {
    for (const cmd of [
      'git status',
      'ls ~/Desktop',
      'echo screencapture-is-a-word-in-this-string.txt',
      'cat notes/screencapture.md',
      "printf 'notes;screencapture usage'", // quoted — must NOT capture the screen
      'grep "screencapture" docs/notes.md',
      'echo hi | grep screencapture',
    ]) {
      expect(isScreenshotShellCommand(cmd)).toBe(false)
    }
  })
})
