import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ownerFindMany: vi.fn(),
  staleFindMany: vi.fn(),
  zombieUpdateMany: vi.fn(),
  activeFindFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  officeBusy: vi.fn(),
  getDevices: vi.fn(),
  getLegacy: vi.fn(),
  sendVoip: vi.fn(),
  sendFcm: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: mocks.ownerFindMany },
    agentAppCall: {
      findMany: mocks.staleFindMany,
      updateMany: mocks.zombieUpdateMany,
      findFirst: mocks.activeFindFirst,
      create: mocks.create,
      update: mocks.update,
    },
    officeCallSession: { findFirst: mocks.officeBusy },
  },
}))
vi.mock('@/agent/lib/office-call-devices', () => ({
  getOfficeCallDeliveryDevicesForUsers: mocks.getDevices,
}))
vi.mock('@/agent/lib/call-push', () => ({ getCallPushTargets: mocks.getLegacy }))
vi.mock('@/agent/lib/apns-voip', () => ({ sendVoipCall: mocks.sendVoip }))
vi.mock('@/agent/lib/fcm-call', () => ({
  fcmCallConfigured: () => true,
  sendFcmCall: mocks.sendFcm,
}))

import { payloadPurposePreview, ringOwnerApp } from '@/agent/lib/agent-app-call'

describe('agent app call delivery registry', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    delete process.env.APNS_PRODUCTION
    mocks.ownerFindMany.mockResolvedValue([{ id: 'owner-1' }])
    mocks.staleFindMany.mockResolvedValue([])
    mocks.zombieUpdateMany.mockResolvedValue({ count: 0 })
    mocks.activeFindFirst.mockResolvedValue(null)
    mocks.officeBusy.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: '897781f0-23a3-4d94-96a3-c78514fa61e9' })
    mocks.update.mockResolvedValue({})
    mocks.getLegacy.mockResolvedValue({ voip: [], fcm: [] })
    mocks.sendVoip.mockImplementation(async (tokens: string[]) =>
      tokens.map((token) => ({ token, ok: true, status: 200 })))
    mocks.sendFcm.mockResolvedValue([])
  })

  it('rings current encrypted-registry devices in their exact APNs environments', async () => {
    const sandbox = 'a'.repeat(64)
    const production = 'b'.repeat(64)
    mocks.getDevices.mockResolvedValue([
      {
        id: 'dev', installationId: 'ios-sandbox', provider: 'apns_voip',
        environment: 'sandbox', token: sandbox,
      },
      {
        id: 'prod', installationId: 'ios-production', provider: 'apns_voip',
        environment: 'production', token: production,
      },
    ])

    await expect(ringOwnerApp({ purpose: 'device test', source: 'manual' })).resolves.toMatchObject({
      ok: true,
      voipSent: 2,
    })
    expect(mocks.sendVoip).toHaveBeenNthCalledWith(
      1, [sandbox], expect.objectContaining({
        type: 'agent_call',
        claimReceipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        // Ring payload carries the brief so the Live model knows why it
        // called BEFORE the owner answers (owner bug 2026-08-15).
        purpose: 'device test',
      }), { environment: 'sandbox' },
    )
    expect(mocks.sendVoip).toHaveBeenNthCalledWith(
      2, [production], expect.objectContaining({ type: 'agent_call' }), { environment: 'production' },
    )
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pushResult: expect.objectContaining({ voip: { attempted: 2, delivered: 2 } }),
      }),
    }))
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eligibleDeviceIds: ['ios-production', 'ios-sandbox'],
        claimReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }))
  })

  it('deduplicates legacy tokens already classified by the current registry', async () => {
    const token = 'c'.repeat(64)
    mocks.getDevices.mockResolvedValue([
      {
        id: 'dev', installationId: 'ios-installation', provider: 'apns_voip',
        environment: 'sandbox', token,
      },
    ])
    mocks.getLegacy.mockResolvedValue({ voip: [token], fcm: [] })

    await expect(ringOwnerApp({ purpose: 'dedupe test', source: 'manual' })).resolves.toMatchObject({ ok: true })
    expect(mocks.sendVoip).toHaveBeenCalledTimes(1)
    expect(mocks.sendVoip).toHaveBeenCalledWith(
      [token], expect.any(Object), { environment: 'sandbox' },
    )
  })

  it('awaits stale-call sweeping before reading busy state or creating a ring', async () => {
    let releaseSweep!: (rows: []) => void
    mocks.staleFindMany.mockReturnValueOnce(new Promise<[]>(resolve => { releaseSweep = resolve }))
    mocks.getDevices.mockResolvedValue([{
      id: 'dev', installationId: 'ios-installation', provider: 'apns_voip',
      environment: 'sandbox', token: 'd'.repeat(64),
    }])

    let settled = false
    const ring = ringOwnerApp({ purpose: 'ordered sweep', source: 'manual' })
      .then(result => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mocks.activeFindFirst).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()

    releaseSweep([])
    await expect(ring).resolves.toMatchObject({ ok: true })
    expect(mocks.activeFindFirst).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  // A rejected VoIP push means NO RING AT ALL, so the payload brief must stay
  // well under the ~5KB limit even for maximum-length Bangla purposes.
  it('byte-caps the ring payload purpose without splitting characters', () => {
    const bangla = 'নামাজ'.repeat(400) // 2000 chars ≈ 6KB UTF-8
    const preview = payloadPurposePreview(bangla)
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(2800)
    expect(bangla.startsWith(preview)).toBe(true)
    // A typical salah brief fits whole.
    const brief = 'এটা নামাজ-তাগাদার কল। '.repeat(30).slice(0, 900)
    expect(payloadPurposePreview(brief)).toBe(brief)
  })
})
