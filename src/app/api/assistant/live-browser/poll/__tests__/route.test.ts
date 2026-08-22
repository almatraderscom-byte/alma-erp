import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  claimNextCommand: vi.fn(),
  isLiveBrowserEnabled: vi.fn(),
  reconcileStaleBrowserExecutions: vi.fn(),
  markLiveBrowserDeviceUpdateRequired: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/agent/lib/live-browser/companion', () => ({
  authenticateDevice: mocks.authenticateDevice,
  claimNextCommand: mocks.claimNextCommand,
  isLiveBrowserEnabled: mocks.isLiveBrowserEnabled,
  reconcileStaleBrowserExecutions: mocks.reconcileStaleBrowserExecutions,
  markLiveBrowserDeviceUpdateRequired: mocks.markLiveBrowserDeviceUpdateRequired,
  LIVE_BROWSER_AUTHORIZE_PROTOCOL: 'authorize-v1',
  supportsLiveBrowserAuthorizeProtocol: (protocol: string | null | undefined) => (
    protocol === 'authorize-v1'
  ),
}))

import { GET } from '../route'

describe('live-browser poll command/preview coupling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateDevice.mockResolvedValue({ id: 'device-1' })
    mocks.isLiveBrowserEnabled.mockResolvedValue(true)
  })

  it('returns only the preview grant atomically coupled to the claimed command', async () => {
    const expiresAt = new Date('2026-08-21T16:30:25.000Z')
    mocks.claimNextCommand.mockResolvedValue({
      id: 'command-a',
      action: 'click',
      params: { ref: 'e1', id: 'attacker-id', action: 'navigate' },
      preview: {
        deviceId: 'device-1',
        turnId: 'turn-a',
        conversationId: 'conversation-a',
        expiresAt,
      },
    })

    const response = await GET(new Request('http://localhost/api/assistant/live-browser/poll', {
      headers: {
        authorization: 'Bearer paired-device-token',
        'x-alma-companion-protocol': 'authorize-v1',
      },
    }) as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      command: { id: 'command-a', action: 'click', ref: 'e1' },
      preview: {
        active: true,
        contextId: 'browser:device-1',
        turnId: 'turn-a',
        conversationId: 'conversation-a',
        expiresAt: expiresAt.toISOString(),
        fps: 1,
        framePath: '/api/assistant/live-browser/frames',
      },
    })
    expect(mocks.claimNextCommand).toHaveBeenCalledWith('device-1', 'authorize-v1')
  })

  it('does not dispatch a command without its required contextual preview grant', async () => {
    mocks.claimNextCommand.mockResolvedValue(null)
    const response = await GET(new Request('http://localhost/api/assistant/live-browser/poll', {
      headers: {
        authorization: 'Bearer paired-device-token',
        'x-alma-companion-protocol': 'authorize-v1',
      },
    }) as never)

    await expect(response.json()).resolves.toEqual({ command: null, preview: null })
  })

  it('keeps a legacy Companion connected but returns update_required without claiming', async () => {
    const response = await GET(new Request('http://localhost/api/assistant/live-browser/poll', {
      headers: { authorization: 'Bearer paired-device-token' },
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      command: null,
      preview: null,
      updateRequired: true,
      requiredProtocol: 'authorize-v1',
    })
    expect(mocks.claimNextCommand).not.toHaveBeenCalled()
    expect(mocks.authenticateDevice).toHaveBeenCalledWith('paired-device-token', {
      touchLastSeen: false,
    })
    expect(mocks.markLiveBrowserDeviceUpdateRequired).toHaveBeenCalledWith('device-1')
  })

  it('reconciles stale executing work while OFF without dispatching a command', async () => {
    mocks.isLiveBrowserEnabled.mockResolvedValue(false)
    mocks.reconcileStaleBrowserExecutions.mockResolvedValue(1)
    const response = await GET(new Request('http://localhost/api/assistant/live-browser/poll', {
      headers: {
        authorization: 'Bearer paired-device-token',
        'x-alma-companion-protocol': 'authorize-v1',
      },
    }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      command: null,
      paused: true,
      preview: null,
    })
    expect(mocks.reconcileStaleBrowserExecutions).toHaveBeenCalledWith('device-1')
    expect(mocks.claimNextCommand).not.toHaveBeenCalled()
  })
})
