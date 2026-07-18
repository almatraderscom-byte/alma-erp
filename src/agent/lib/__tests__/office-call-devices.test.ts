import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  txDeleteMany: vi.fn(),
  txUpsert: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    officeCallDevice: {
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
    },
  },
}))

import {
  decryptOfficeCallDeviceToken,
  getOfficeCallDeliveryDevices,
  registerOfficeCallDevice,
  unregisterOfficeCallInstallation,
} from '@/agent/lib/office-call-devices'

const IOS_TOKEN = 'a'.repeat(64)

describe('encrypted Office call device registry', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'test-only-office-call-device-key'
    mocks.transaction.mockReset()
    mocks.txDeleteMany.mockReset().mockResolvedValue({ count: 0 })
    mocks.txUpsert.mockReset().mockResolvedValue({ id: 'device-1' })
    mocks.deleteMany.mockReset()
    mocks.updateMany.mockReset()
    mocks.findMany.mockReset()
    mocks.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
      officeCallDevice: {
        deleteMany: mocks.txDeleteMany,
        upsert: mocks.txUpsert,
      },
    }))
  })

  it('stores a hash and authenticated ciphertext, never the raw provider token', async () => {
    await expect(registerOfficeCallDevice({
      userId: 'user-1',
      businessId: 'ALMA_LIFESTYLE',
      installationId: 'ios-installation-1',
      platform: 'ios',
      environment: 'production',
      provider: 'apns_voip',
      token: IOS_TOKEN,
      appBuild: '20',
      buildSha: 'abcdef',
    })).resolves.toEqual({ ok: true, deviceId: 'device-1' })
    const call = mocks.txUpsert.mock.calls[0][0]
    expect(call.create.providerTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(call.create.providerTokenEnc).not.toContain(IOS_TOKEN)
    expect(call.create.providerTokenEnc).toMatch(/^v1:/)
    expect(decryptOfficeCallDeviceToken(call.create.providerTokenEnc)).toBe(IOS_TOKEN)
  })

  it('deletes the prior encrypted token when the same installation rotates', async () => {
    await registerOfficeCallDevice({
      userId: 'user-1',
      businessId: 'ALMA_LIFESTYLE',
      installationId: 'android-installation-1',
      platform: 'android',
      environment: 'production',
      provider: 'fcm',
      token: 'fcm-token-value-that-is-long-enough',
    })
    expect(mocks.txDeleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'user-1',
        installationId: 'android-installation-1',
        provider: 'fcm',
        providerTokenHash: { not: expect.any(String) },
      }),
    })
  })

  it('rejects provider/platform mismatch and malformed APNs tokens before DB access', async () => {
    await expect(registerOfficeCallDevice({
      userId: 'user-1',
      businessId: 'ALMA_LIFESTYLE',
      installationId: 'bad-1',
      platform: 'android',
      environment: 'production',
      provider: 'apns_voip',
      token: IOS_TOKEN,
    })).resolves.toEqual({ ok: false, error: 'provider_platform_mismatch' })
    await expect(registerOfficeCallDevice({
      userId: 'user-1',
      businessId: 'ALMA_LIFESTYLE',
      installationId: 'bad-2',
      platform: 'ios',
      environment: 'production',
      provider: 'apns_voip',
      token: 'not-an-apns-token-but-long-enough',
    })).resolves.toEqual({ ok: false, error: 'invalid_provider_token' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('scopes logout deletion to the authenticated user and installation', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 2 })
    await expect(unregisterOfficeCallInstallation({
      userId: 'user-1',
      installationId: 'shared-phone-1',
    })).resolves.toBe(2)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', installationId: 'shared-phone-1' },
    })
  })

  it('drops unreadable device ciphertext instead of exposing or dispatching it', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'bad-device',
      platform: 'android',
      environment: 'production',
      provider: 'fcm',
      providerTokenEnc: 'v1:broken:broken:broken',
      appBuild: null,
      buildSha: null,
    }])
    await expect(getOfficeCallDeliveryDevices({
      userId: 'user-1',
      businessId: 'ALMA_LIFESTYLE',
    })).resolves.toEqual([])
  })
})
