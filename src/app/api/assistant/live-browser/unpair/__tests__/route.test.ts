import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  revokeDeviceSafely: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/agent/lib/live-browser/companion', () => ({
  authenticateDevice: mocks.authenticateDevice,
  revokeDeviceSafely: mocks.revokeDeviceSafely,
}))

import { POST } from '../route'

function request(token = 'paired-device-token') {
  return new Request('http://localhost/api/assistant/live-browser/unpair', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }) as never
}

describe('live-browser device Unpair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateDevice.mockResolvedValue({ id: 'device-1' })
  })

  it('revokes the server bearer and pending commands before acknowledging Unpair', async () => {
    mocks.revokeDeviceSafely.mockResolvedValue({
      revoked: true,
      inFlightEffects: 0,
      stoppedQueuedOrDelivered: 2,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      revoked: true,
      stoppedQueuedOrDelivered: 2,
    })
    expect(mocks.revokeDeviceSafely).toHaveBeenCalledWith('device-1')
    expect(mocks.authenticateDevice).toHaveBeenCalledWith('paired-device-token', {
      allowRevocationPending: true,
    })
  })

  it('keeps the bearer revocable while an already-authorized step settles', async () => {
    mocks.revokeDeviceSafely.mockResolvedValue({
      revoked: false,
      inFlightEffects: 1,
      stoppedQueuedOrDelivered: 0,
    })

    const response = await POST(request())

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stopping: true,
      inFlightEffects: 1,
    })
  })

  it('does not reveal or revoke anything for an invalid bearer', async () => {
    mocks.authenticateDevice.mockResolvedValue(null)

    const response = await POST(request('bad-token'))

    expect(response.status).toBe(401)
    expect(mocks.revokeDeviceSafely).not.toHaveBeenCalled()
  })
})
