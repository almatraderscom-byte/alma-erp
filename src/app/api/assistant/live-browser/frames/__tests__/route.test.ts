import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { frameMatchesLease, parseBrowserFrame } from '../route'

describe('live-browser frame contract', () => {
  const now = Date.parse('2026-08-19T10:00:00.000Z')
  const base = {
    dataUri: 'data:image/jpeg;base64,AAA=',
    contextId: 'tab:42',
    capturedAt: '2026-08-19T09:59:59.000Z',
    turnId: 'turn-1',
    conversationId: 'conv-1',
  }

  it('accepts only canonical Chrome tab contexts', () => {
    expect(parseBrowserFrame(base, now).ok).toBe(true)
    for (const contextId of ['tab:0', 'tab:-1', 'window:42', 'tab:42:extra', 'anything']) {
      expect(parseBrowserFrame({ ...base, contextId }, now)).toEqual({
        ok: false,
        error: 'invalid_context',
      })
    }
  })

  it('rejects stale and future producer clocks', () => {
    expect(parseBrowserFrame({ ...base, capturedAt: '2026-08-19T09:57:59.000Z' }, now))
      .toEqual({ ok: false, error: 'invalid_capture_time' })
    expect(parseBrowserFrame({ ...base, capturedAt: '2026-08-19T10:00:06.000Z' }, now))
      .toEqual({ ok: false, error: 'invalid_capture_time' })
  })

  it('requires the exact lease identity on every frame', () => {
    expect(parseBrowserFrame({ ...base, turnId: '' }, now))
      .toEqual({ ok: false, error: 'invalid_activity_identity' })
    expect(parseBrowserFrame({ ...base, conversationId: '' }, now))
      .toEqual({ ok: false, error: 'invalid_activity_identity' })
    expect(frameMatchesLease(base, { turnId: 'turn-1', conversationId: 'conv-1' })).toBe(true)
    expect(frameMatchesLease(base, { turnId: 'turn-2', conversationId: 'conv-1' })).toBe(false)
  })

  it('bridges native lease renewal to a companion busy inside one command', () => {
    const route = readFileSync(join(process.cwd(),
      'src/app/api/assistant/live-browser/frames/route.ts'), 'utf8')
    const extension = readFileSync(join(process.cwd(),
      'extension/alma-companion/background.js'), 'utf8')
    expect(route).toContain('leaseExpiresAt: lease.expiresAt.toISOString()')
    expect(extension).toContain("const renewedExpiry = typeof ack?.leaseExpiresAt === 'string'")
    expect(extension).toContain("previewGrant = { ...current, expiresAt: ack.leaseExpiresAt }")
  })
})
