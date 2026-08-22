import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  authorizeClaimedBrowserCommand: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/agent/lib/live-browser/companion', () => ({
  authenticateDevice: mocks.authenticateDevice,
  authorizeClaimedBrowserCommand: mocks.authorizeClaimedBrowserCommand,
}))

import { POST } from '../route'

function request(body: unknown, token = 'paired-device-token') {
  return new Request('http://localhost/api/assistant/live-browser/authorize', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }) as never
}

describe('live-browser final command authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateDevice.mockResolvedValue({ id: 'device-1' })
  })

  it('returns the strict authorized decision for the paired device', async () => {
    mocks.authorizeClaimedBrowserCommand.mockResolvedValue({ authorized: true })

    const response = await POST(request({ commandId: 'command-1' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ authorized: true })
    expect(mocks.authenticateDevice).toHaveBeenCalledWith('paired-device-token')
    expect(mocks.authorizeClaimedBrowserCommand).toHaveBeenCalledWith('device-1', 'command-1')
  })

  it('returns conflict when the final durable fence denies the command', async () => {
    mocks.authorizeClaimedBrowserCommand.mockResolvedValue({
      authorized: false,
      reason: 'owner_authority_changed',
    })

    const response = await POST(request({ commandId: 'command-1' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      authorized: false,
      reason: 'owner_authority_changed',
    })
  })

  it('never reaches command authorization for an invalid device bearer', async () => {
    mocks.authenticateDevice.mockResolvedValue(null)

    const response = await POST(request({ commandId: 'command-1' }, 'bad-token'))

    expect(response.status).toBe(401)
    expect(mocks.authorizeClaimedBrowserCommand).not.toHaveBeenCalled()
  })
})
