import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: { agentKvSetting: { findUnique: mocks.findUnique } },
}))

import {
  cameraLeaseTokenRequired,
  cameraRequestAuthorized,
  cameraTokensEqual,
  getCameraCredential,
} from '../camera-auth'

describe('camera machine credentials', () => {
  beforeEach(() => mocks.findUnique.mockReset())

  it('compares tokens safely without throwing on a length mismatch', () => {
    expect(cameraTokensEqual('same-secret', 'same-secret')).toBe(true)
    expect(cameraTokensEqual('short', 'much-longer-secret')).toBe(false)
    expect(cameraTokensEqual('', '')).toBe(false)
  })

  it('uses a dedicated listener token when configured', async () => {
    mocks.findUnique.mockResolvedValueOnce({ value: 'listener-secret' })
    await expect(getCameraCredential('listener')).resolves.toEqual({
      token: 'listener-secret',
      source: 'dedicated',
    })
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'camera_listener_token' },
    }))
  })

  it('falls back to the deployed bridge token during listener migration', async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ value: 'legacy-secret' })
    await expect(cameraRequestAuthorized(
      new Headers({ authorization: 'Bearer legacy-secret' }),
      'listener',
    )).resolves.toEqual({ ok: true, credentialSource: 'bridge_fallback' })
    expect(mocks.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { key: 'camera_bridge_token' },
    }))
  })

  it('enables strict lease acknowledgements only for explicit true values', async () => {
    mocks.findUnique.mockResolvedValue({ value: 'on' })
    await expect(cameraLeaseTokenRequired()).resolves.toBe(true)
    mocks.findUnique.mockResolvedValue({ value: 'off' })
    await expect(cameraLeaseTokenRequired()).resolves.toBe(false)
  })
})
