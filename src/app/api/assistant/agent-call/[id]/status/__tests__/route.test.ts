import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  legacyAllowed: true,
  mark: vi.fn(),
  appendNote: vi.fn(),
  status: vi.fn(),
  brief: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => ({ sub: 'owner-1' })) }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: vi.fn(() => true) }))
vi.mock('@/agent/lib/agent-app-call', () => ({
  AGENT_APP_CALL_LEGACY_V1_SUNSET_AT: '2026-09-15T00:00:00.000Z',
  AGENT_APP_CALL_STATUS_CONTRACT_VERSION: 2,
  agentAppCallLegacyV1Allowed: () => mocks.legacyAllowed,
  legacyAgentAppCallDeviceId: (ownerId: string) => `legacy-v1-owner:${ownerId.padEnd(32, '0').slice(0, 32)}`,
  appendAgentAppCallDeviceNote: mocks.appendNote,
  getAgentAppCallStatus: mocks.status,
  getAgentAppCallBrief: mocks.brief,
  markAgentAppCall: mocks.mark,
  normalizeAgentAppCallDeviceId: (value: unknown) => {
    if (typeof value !== 'string') return null
    const id = value.trim()
    return id && id.length <= 180 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : null
  },
}))

import { POST } from '@/app/api/assistant/agent-call/[id]/status/route'

const props = { params: Promise.resolve({ id: 'call-1' }) }

function request(body: unknown) {
  return new NextRequest('https://app.example/api/assistant/agent-call/call-1/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.legacyAllowed = true
  mocks.mark.mockResolvedValue({
    ok: true,
    changed: true,
    idempotent: false,
    superseded: false,
    status: 'failed',
  })
  mocks.appendNote.mockResolvedValue({
    ok: true,
    changed: true,
    idempotent: false,
    superseded: false,
    status: 'answered',
  })
})

describe('Agent app-call status route terminal contract', () => {
  it('accepts a truthful failed terminal state with the stable device id', async () => {
    const response = await POST(request({
      contractVersion: 2,
      status: 'failed',
      deviceId: 'ios-installation-a',
      note: 'microphone permission denied',
    }), props)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      changed: true,
      status: 'failed',
    })
    expect(mocks.mark).toHaveBeenCalledWith('call-1', {
      status: 'failed',
      deviceId: 'ios-installation-a',
      legacyV1: false,
      summary: '[device] microphone permission denied',
    })
  })

  it('fails closed when a lifecycle transition omits its device id', async () => {
    const response = await POST(request({ contractVersion: 2, status: 'answered' }), props)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'device_id_required',
      retryable: false,
    })
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('returns an exact proof error when id and bearer receipt match no ring target', async () => {
    mocks.mark.mockResolvedValueOnce({
      ok: false,
      changed: false,
      error: 'claim_receipt_required',
      retryable: false,
      status: 'ringing',
    })
    const response = await POST(request({
      contractVersion: 2,
      status: 'answered',
      deviceId: 'unregistered-installation',
    }), props)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'claim_receipt_required',
      retryable: false,
    })
    expect(mocks.mark).toHaveBeenCalledWith('call-1', expect.objectContaining({
      status: 'answered',
      deviceId: 'unregistered-installation',
      legacyV1: false,
    }))
  })

  it('forwards the additive ring receipt into the v2 ownership CAS', async () => {
    const receipt = Buffer.alloc(32, 9).toString('base64url')
    const response = await POST(request({
      contractVersion: 2,
      status: 'answered',
      deviceId: 'ios-installation-a',
      claimReceipt: receipt,
    }), props)

    expect(response.status).toBe(200)
    expect(mocks.mark).toHaveBeenCalledWith('call-1', expect.objectContaining({
      deviceId: 'ios-installation-a',
      claimReceipt: receipt,
    }))
  })

  it('returns an actionable non-retryable ownership conflict without a side write', async () => {
    mocks.mark.mockResolvedValueOnce({
      ok: false,
      changed: false,
      error: 'device_mismatch',
      retryable: false,
      status: 'answered',
    })

    const response = await POST(request({
      contractVersion: 2,
      status: 'failed',
      deviceId: 'ios-installation-b',
      note: 'late failure from another phone',
    }), props)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'device_mismatch',
      retryable: false,
      status: 'answered',
    })
    expect(mocks.appendNote).not.toHaveBeenCalled()
  })

  it('maps an omitted version to a temporary authenticated-owner legacy identity', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.mark.mockResolvedValueOnce({
      ok: true, changed: true, idempotent: false, superseded: false, status: 'answered',
    })

    const response = await POST(request({ status: 'answered' }), props)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ contractVersion: 1, status: 'answered' })
    expect(mocks.mark).toHaveBeenCalledWith('call-1', expect.objectContaining({
      deviceId: expect.stringMatching(/^legacy-v1-owner:/),
      legacyV1: true,
    }))
    expect(warn).toHaveBeenCalledWith(
      '[agent-call] legacy-v1 status contract',
      expect.objectContaining({
        legacyDeviceId: expect.stringMatching(/^legacy-v1-owner:/),
        accepted: true,
      }),
    )
    warn.mockRestore()
  })

  it('rejects unknown explicit versions and sunsets omitted-version clients', async () => {
    const unknown = await POST(request({ contractVersion: 3, status: 'answered', deviceId: 'dev-a' }), props)
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toMatchObject({ error: 'unsupported_contract_version' })
    expect(mocks.mark).not.toHaveBeenCalled()

    mocks.legacyAllowed = false
    const sunset = await POST(request({ status: 'answered' }), props)
    expect(sunset.status).toBe(426)
    await expect(sunset.json()).resolves.toMatchObject({ error: 'legacy_contract_sunset' })
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('rejects a foreign note without persistence or diagnostic logging', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.appendNote.mockResolvedValueOnce({
      ok: false,
      changed: false,
      error: 'device_mismatch',
      retryable: false,
      status: 'answered',
    })

    const response = await POST(request({
      contractVersion: 2,
      deviceId: 'ios-installation-b',
      note: 'foreign diagnostic',
    }), props)

    expect(response.status).toBe(409)
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalledWith(
      '[agent-call] accepted device note',
      expect.anything(),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('logs a note only after its ownership-gated append resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await POST(request({
      contractVersion: 2,
      deviceId: 'ios-installation-a',
      note: 'accepted diagnostic',
    }), props)

    expect(response.status).toBe(200)
    const logOrder = warn.mock.invocationCallOrder.find((_, index) =>
      warn.mock.calls[index]?.[0] === '[agent-call] accepted device note')
    expect(logOrder).toBeGreaterThan(mocks.appendNote.mock.invocationCallOrder[0])
    warn.mockRestore()
  })

  it('atomically preserves a note beside an explicit summary before acknowledging it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await POST(request({
      contractVersion: 2,
      status: 'failed',
      deviceId: 'ios-installation-a',
      summary: 'provider startup failed',
      note: 'microphone permission denied',
    }), props)

    expect(response.status).toBe(200)
    expect(mocks.mark).toHaveBeenCalledWith('call-1', expect.objectContaining({
      summary: 'provider startup failed\n[device] microphone permission denied',
    }))
    await expect(response.json()).resolves.toMatchObject({ noteSaved: true })
    expect(warn).toHaveBeenCalledWith(
      '[agent-call] accepted device note',
      'call-1',
      'microphone permission denied',
    )
    warn.mockRestore()
  })
})
