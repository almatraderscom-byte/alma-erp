import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  resolveSessionStaff: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/office-staff', () => ({ resolveSessionStaff: mocks.resolveSessionStaff }))

import { decideOfficeAgoraGrant, identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'

function request(businessId?: string) {
  const query = businessId ? `?businessId=${encodeURIComponent(businessId)}` : ''
  return new NextRequest(`https://alma.example/api/assistant/office/calls${query}`)
}

describe('office call request identity', () => {
  beforeEach(() => {
    mocks.getToken.mockReset()
    mocks.resolveSessionStaff.mockReset()
  })

  it('rejects an unauthenticated caller', async () => {
    mocks.getToken.mockResolvedValue(null)
    await expect(identifyOfficeCallRequest(request())).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
      code: 401,
    })
  })

  it('rejects owner cross-business access outside the exact membership list', async () => {
    mocks.getToken.mockResolvedValue({
      sub: 'owner-1',
      role: 'SUPER_ADMIN',
      businessAccess: 'ALMA_LIFESTYLE',
    })
    await expect(identifyOfficeCallRequest(request('ALMA_TRADING'))).resolves.toEqual({
      ok: false,
      error: 'forbidden',
      code: 403,
    })
  })

  it('uses the active staff record as the authoritative business scope', async () => {
    mocks.getToken.mockResolvedValue({ sub: 'staff-1', role: 'STAFF' })
    mocks.resolveSessionStaff.mockResolvedValue({
      id: 'agent-staff-1',
      name: 'Staff',
      businessId: 'ALMA_LIFESTYLE',
    })
    await expect(identifyOfficeCallRequest(request('ALMA_TRADING'))).resolves.toEqual({
      ok: true,
      userId: 'staff-1',
      businessId: 'ALMA_LIFESTYLE',
      role: 'staff',
    })
  })

  it('rejects a non-owner without an active Office staff membership', async () => {
    mocks.getToken.mockResolvedValue({ sub: 'former-staff', role: 'STAFF' })
    mocks.resolveSessionStaff.mockResolvedValue(null)
    await expect(identifyOfficeCallRequest(request())).resolves.toEqual({
      ok: false,
      error: 'forbidden',
      code: 403,
    })
  })
})

describe('office Agora channel grant', () => {
  const live = 'itc_live_ALMA_LIFESTYLE'
  const callId = '24d406b4-753c-4e2d-aa0d-1bb2c3e335aa'

  it('allows only the owner to publish into the exact business live channel', () => {
    expect(decideOfficeAgoraGrant({ channel: live, expectedLiveChannel: live, identityRole: 'owner' })).toMatchObject({
      ok: true,
      kind: 'live',
      rtcRole: 'publisher',
    })
    expect(decideOfficeAgoraGrant({ channel: live, expectedLiveChannel: live, identityRole: 'staff' })).toMatchObject({
      ok: true,
      kind: 'live',
      rtcRole: 'subscriber',
    })
  })

  it('rejects cross-business and arbitrary Agora channels', () => {
    expect(decideOfficeAgoraGrant({
      channel: 'itc_live_ALMA_TRADING',
      expectedLiveChannel: live,
      identityRole: 'owner',
    })).toEqual({ ok: false, error: 'invalid_call_channel' })
    expect(decideOfficeAgoraGrant({ channel: 'private-room', expectedLiveChannel: live, identityRole: 'owner' })).toEqual({
      ok: false,
      error: 'invalid_call_channel',
    })
  })

  it('keeps structurally valid direct calls publisher-capable for participant authorization', () => {
    expect(decideOfficeAgoraGrant({
      channel: `itc_${callId}`,
      expectedLiveChannel: live,
      identityRole: 'staff',
    })).toEqual({ ok: true, kind: 'call', rtcRole: 'publisher', callId })
  })
})
