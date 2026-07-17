import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createEvent, logEvent } = vi.hoisted(() => ({
  createEvent: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { officeCallEvent: { create: createEvent } },
}))
vi.mock('@/lib/logger', () => ({
  logEvent,
  errorMeta: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

import {
  callIdFromAgoraChannel,
  isOfficeCallClientEvent,
  recordOfficeCallEvent,
  safeRecordOfficeCallEvent,
  sanitizeOfficeCallMetadata,
  summarizeCallDelivery,
} from '@/agent/lib/office-call-observability'

const CALL_ID = '155f816f-82f4-48f1-9c4a-2d57800f6e97'

describe('office call observability', () => {
  beforeEach(() => {
    createEvent.mockReset().mockResolvedValue({ id: 'event-1' })
    logEvent.mockReset()
  })

  it('extracts only a UUID call id and rejects shared live channels', () => {
    expect(callIdFromAgoraChannel(`itc_${CALL_ID}`)).toBe(CALL_ID)
    expect(callIdFromAgoraChannel('itc_live_ALMA_LIFESTYLE')).toBeNull()
    expect(callIdFromAgoraChannel('itc_not-a-uuid')).toBeNull()
  })

  it('allows the explicit client event contract only', () => {
    expect(isOfficeCallClientEvent('client.peer_joined')).toBe(true)
    expect(isOfficeCallClientEvent('server.admin_override')).toBe(false)
  })

  it('redacts secrets and bounds diagnostic metadata', () => {
    const cleaned = sanitizeOfficeCallMetadata({
      token: 'raw-device-token',
      nested: { authorization: 'Bearer secret', safe: 'x'.repeat(300) },
    })
    expect(cleaned).toEqual({
      token: '[redacted]',
      nested: { authorization: '[redacted]', safe: 'x'.repeat(180) },
    })
  })

  it('summarizes provider delivery without retaining tokens or raw response bodies', () => {
    expect(
      summarizeCallDelivery([
        { ok: true, status: 200 },
        { ok: false, status: 410, reason: 'Unregistered token abc' },
        { ok: false, reason: 'request timeout with token abc' },
      ]),
    ).toEqual({
      attempted: 3,
      succeeded: 1,
      failed: 2,
      reasons: { http_410: 1, timeout: 1 },
    })
  })

  it('persists and logs one correlated event', async () => {
    await recordOfficeCallEvent({
      callId: CALL_ID,
      businessId: 'ALMA_LIFESTYLE',
      event: 'client.local_joined',
      source: 'web',
      platform: 'web',
      deviceId: 'raw-device-id',
      metadata: { token: 'must-not-survive', codec: 'vp8' },
    })
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        callId: CALL_ID,
        event: 'client.local_joined',
        deviceId: expect.not.stringContaining('raw-device-id'),
        metadata: { token: '[redacted]', codec: 'vp8' },
      }),
    })
    expect(logEvent).toHaveBeenCalledWith(
      'info',
      'office_call.client.local_joined',
      expect.objectContaining({ callId: CALL_ID }),
    )
  })

  it('fails open when the event ledger is unavailable', async () => {
    createEvent.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(
      safeRecordOfficeCallEvent({
        callId: CALL_ID,
        businessId: 'ALMA_LIFESTYLE',
        event: 'call.created',
        source: 'server',
      }),
    ).resolves.toBeUndefined()
    expect(logEvent).toHaveBeenCalledWith(
      'warn',
      'office_call.observability_write_failed',
      expect.objectContaining({ callId: CALL_ID, message: 'database unavailable' }),
    )
  })
})
