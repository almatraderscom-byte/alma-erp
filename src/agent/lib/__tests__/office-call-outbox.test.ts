import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findFirst: vi.fn(),
  claim: vi.fn(),
  update: vi.fn(),
  getDevices: vi.fn(),
  invalidate: vi.fn(),
  sendVoip: vi.fn(),
  sendFcm: vi.fn(),
  pushFallback: vi.fn(),
  recordEvent: vi.fn(),
  transition: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    officeCallOutbox: { update: mocks.update },
  },
}))
vi.mock('@/agent/lib/office-call-devices', () => ({
  getOfficeCallDeliveryDevices: mocks.getDevices,
  invalidateOfficeCallDeviceToken: mocks.invalidate,
}))
vi.mock('@/agent/lib/apns-voip', () => ({ sendVoipCall: mocks.sendVoip }))
vi.mock('@/agent/lib/fcm-call', () => ({ sendFcmCall: mocks.sendFcm }))
vi.mock('@/agent/lib/office-notify', () => ({ pushStaffDevice: mocks.pushFallback }))
vi.mock('@/agent/lib/office-call-domain', () => ({ transitionCanonicalOfficeCall: mocks.transition }))
vi.mock('@/agent/lib/office-call-observability', () => ({
  safeRecordOfficeCallEvent: mocks.recordEvent,
  summarizeCallDelivery: (results: Array<{ ok: boolean }>) => ({
    attempted: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    reasons: {},
  }),
}))

import { processOfficeCallOutbox } from '@/agent/lib/office-call-outbox'

function item(kind: 'call.ring' | 'call.cancel') {
  return {
    id: `outbox-${kind}`,
    callId: 'call-1',
    targetUserId: 'callee',
    kind,
    attempts: 0,
    availableAt: new Date(),
    createdAt: new Date(),
    payload: {
      schemaVersion: 1,
      event: kind === 'call.ring' ? 'ring' : 'cancel',
      callId: 'call-1',
      callUUID: 'call-1',
      channel: 'itc_call-1',
      callerName: 'Caller',
    },
    call: {
      id: 'call-1',
      businessId: 'ALMA_LIFESTYLE',
      state: kind === 'call.ring' ? 'RINGING' : 'ENDED',
      ringExpiresAt: new Date(Date.now() + 60_000),
      maxEndsAt: new Date(Date.now() + 600_000),
    },
  }
}

describe('Office call durable delivery outbox', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
      officeCallOutbox: {
        findFirst: mocks.findFirst,
        updateMany: mocks.claim,
      },
    }))
    mocks.claim.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.recordEvent.mockResolvedValue(undefined)
    mocks.transition.mockResolvedValue({ ok: true, state: 'ENDED', version: 1, alreadyApplied: false, terminalReason: 'PUSH_UNREACHABLE' })
    mocks.invalidate.mockResolvedValue(undefined)
    mocks.pushFallback.mockResolvedValue({ ok: true, attempted: 1, status: 200 })
  })

  it('marks a no-device ring dead and makes server truth push_unreachable', async () => {
    mocks.findFirst.mockResolvedValueOnce(item('call.ring'))
    mocks.getDevices.mockResolvedValue([])
    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 0,
      dead: 1,
      skipped: 0,
    })
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'outbox-call.ring' },
      data: expect.objectContaining({ status: 'DEAD', lastErrorCode: 'no_eligible_device' }),
    })
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-1',
      actorRole: 'server',
      target: 'ENDED',
      reason: 'PUSH_UNREACHABLE',
    }))
  })

  it('backs off a transient provider failure without falsely ending the call', async () => {
    mocks.findFirst.mockResolvedValueOnce(item('call.ring'))
    mocks.getDevices.mockResolvedValue([{
      id: 'android-1',
      provider: 'fcm',
      platform: 'android',
      environment: 'production',
      token: 'fcm-token-value-that-is-long-enough',
    }])
    mocks.sendFcm.mockResolvedValue([{
      token: 'fcm-token-value-that-is-long-enough',
      ok: false,
      reason: 'timeout',
    }])
    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toMatchObject({ failed: 1, dead: 0 })
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'outbox-call.ring' },
      data: expect.objectContaining({
        status: 'FAILED',
        lastErrorCode: 'provider_transient_failure',
        availableAt: expect.any(Date),
      }),
    })
    expect(mocks.transition).not.toHaveBeenCalled()
  })

  it('uses regular notification fallback, never VoIP push, for cancellation', async () => {
    mocks.findFirst.mockResolvedValueOnce(item('call.cancel'))
    mocks.getDevices.mockResolvedValue([{
      id: 'ios-1',
      provider: 'apns_voip',
      platform: 'ios',
      environment: 'production',
      token: 'a'.repeat(64),
    }])
    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toMatchObject({ delivered: 1 })
    expect(mocks.sendVoip).not.toHaveBeenCalled()
    expect(mocks.pushFallback).toHaveBeenCalledWith(
      ['callee'],
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ type: 'office_call_cancel', callId: 'call-1' }),
      true,
    )
  })

  it('does not dispatch when another worker wins the atomic claim', async () => {
    mocks.findFirst.mockResolvedValueOnce(item('call.ring'))
    mocks.claim.mockResolvedValueOnce({ count: 0 })
    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
    })
    expect(mocks.getDevices).not.toHaveBeenCalled()
  })

  it('reconciles and skips a late ring instead of waking a device', async () => {
    const late = item('call.ring')
    late.call.ringExpiresAt = new Date(Date.now() - 1_000)
    mocks.findFirst.mockResolvedValueOnce(late)
    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toMatchObject({ skipped: 1 })
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      actorRole: 'server',
      callId: 'call-1',
      target: 'ENDED',
      reason: 'MISSED',
    }))
    expect(mocks.sendVoip).not.toHaveBeenCalled()
    expect(mocks.sendFcm).not.toHaveBeenCalled()
  })

  it('never mixes APNs sandbox and production tokens in one provider request', async () => {
    mocks.findFirst.mockResolvedValueOnce(item('call.ring'))
    mocks.getDevices.mockResolvedValue([
      { id: 'ios-dev', provider: 'apns_voip', platform: 'ios', environment: 'sandbox', token: 'a'.repeat(64) },
      { id: 'ios-prod', provider: 'apns_voip', platform: 'ios', environment: 'production', token: 'b'.repeat(64) },
    ])
    mocks.sendVoip.mockImplementation(async (tokens: string[]) => tokens.map((token) => ({ token, ok: true, status: 200 })))

    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toMatchObject({ delivered: 1 })
    expect(mocks.sendVoip).toHaveBeenNthCalledWith(
      1,
      ['a'.repeat(64)],
      expect.objectContaining({ callId: 'call-1', schemaVersion: 1 }),
      { environment: 'sandbox' },
    )
    expect(mocks.sendVoip).toHaveBeenNthCalledWith(
      2,
      ['b'.repeat(64)],
      expect.objectContaining({ callId: 'call-1', schemaVersion: 1 }),
      { environment: 'production' },
    )
  })

  it('invalidates a permanently rejected FCM token and exposes push_unreachable', async () => {
    const token = 'fcm-token-value-that-is-long-enough'
    mocks.findFirst.mockResolvedValueOnce(item('call.ring'))
    mocks.getDevices.mockResolvedValue([{
      id: 'android-1', provider: 'fcm', platform: 'android', environment: 'production', token,
    }])
    mocks.sendFcm.mockResolvedValue([{ token, ok: false, status: 404, reason: 'UNREGISTERED' }])

    await expect(processOfficeCallOutbox({ limit: 1 })).resolves.toMatchObject({ dead: 1 })
    expect(mocks.invalidate).toHaveBeenCalledWith('fcm', token)
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      target: 'ENDED',
      reason: 'PUSH_UNREACHABLE',
    }))
  })
})
