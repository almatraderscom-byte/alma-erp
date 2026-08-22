import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  getActiveBrowserPreviewLease: vi.fn(),
  isLiveBrowserEnabled: vi.fn(),
  storeBrowserPreviewFrame: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/agent/lib/live-browser/companion', () => ({
  authenticateDevice: mocks.authenticateDevice,
  getActiveBrowserPreviewLease: mocks.getActiveBrowserPreviewLease,
  isLiveBrowserEnabled: mocks.isLiveBrowserEnabled,
  storeBrowserPreviewFrame: mocks.storeBrowserPreviewFrame,
}))

import { frameMatchesLease, parseBrowserFrame, POST } from '../route'

describe('live-browser frame contract', () => {
  const now = Date.parse('2026-08-19T10:00:00.000Z')
  const base = {
    dataUri: 'data:image/jpeg;base64,AAA=',
    contextId: 'tab:42',
    capturedAt: '2026-08-19T09:59:59.000Z',
    turnId: 'turn-1',
    conversationId: 'conv-1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateDevice.mockResolvedValue({ id: 'device-1' })
    mocks.isLiveBrowserEnabled.mockResolvedValue(true)
    mocks.storeBrowserPreviewFrame.mockResolvedValue({
      accepted: true,
      frameAt: new Date(base.capturedAt),
      frameSeq: 1,
    })
  })

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

  it('keeps only the exact executing preview ingest alive while global STOP is OFF', async () => {
    const capturedAt = new Date().toISOString()
    const lease = {
      deviceId: 'device-1',
      turnId: 'turn-1',
      conversationId: 'conv-1',
      expiresAt: new Date(Date.now() + 30_000),
    }
    mocks.isLiveBrowserEnabled.mockResolvedValue(false)
    mocks.getActiveBrowserPreviewLease.mockResolvedValue(lease)
    mocks.storeBrowserPreviewFrame.mockResolvedValue({
      accepted: true,
      frameAt: new Date(capturedAt),
      frameSeq: 2,
    })

    const response = await POST(new Request('http://localhost/api/assistant/live-browser/frames', {
      method: 'POST',
      headers: {
        authorization: 'Bearer paired-device-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...base, capturedAt }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.getActiveBrowserPreviewLease).toHaveBeenCalledWith('device-1', {
      requireExecuting: true,
    })
    expect(mocks.storeBrowserPreviewFrame).toHaveBeenCalledOnce()
  })

  it('requires the exact executing preview while device revocation is pending', async () => {
    const capturedAt = new Date().toISOString()
    mocks.authenticateDevice.mockResolvedValue({
      id: 'device-1',
      revocationPending: true,
    })
    mocks.getActiveBrowserPreviewLease.mockResolvedValue({
      deviceId: 'device-1',
      turnId: 'turn-1',
      conversationId: 'conv-1',
      expiresAt: new Date(Date.now() + 30_000),
    })

    const response = await POST(new Request('http://localhost/api/assistant/live-browser/frames', {
      method: 'POST',
      headers: {
        authorization: 'Bearer pending-device-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...base, capturedAt }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.authenticateDevice).toHaveBeenCalledWith('pending-device-token', {
      allowRevocationPending: true,
    })
    expect(mocks.getActiveBrowserPreviewLease).toHaveBeenCalledWith('device-1', {
      requireExecuting: true,
    })
  })

  it('rejects frame ingest while OFF when no exact executing lease remains', async () => {
    mocks.isLiveBrowserEnabled.mockResolvedValue(false)
    mocks.getActiveBrowserPreviewLease.mockResolvedValue(null)
    const response = await POST(new Request('http://localhost/api/assistant/live-browser/frames', {
      method: 'POST',
      headers: {
        authorization: 'Bearer paired-device-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...base, capturedAt: new Date().toISOString() }),
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'live_browser_disabled' })
    expect(mocks.storeBrowserPreviewFrame).not.toHaveBeenCalled()
  })
})
