import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CallRow = {
  id: string
  status: string
  answeredAt: Date | null
  answeringDeviceId: string | null
  eligibleDeviceIds: string[]
  claimReceiptHash: string | null
  endedAt: Date | null
  summary: string | null
  createdAt: Date
  updatedAt: Date
  source: string
  purpose: string
}

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  ownerFindMany: vi.fn(),
  getDevices: vi.fn(),
  getLegacy: vi.fn(),
  sendVoip: vi.fn(),
  sendFcm: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentAppCall: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
    user: { findMany: mocks.ownerFindMany },
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

import {
  AGENT_APP_CALL_LEGACY_V1_SUNSET_AT,
  agentAppCallLegacyV1Allowed,
  appendAgentAppCallDeviceNote,
  getAgentAppCallStatus,
  legacyAgentAppCallDeviceId,
  markAgentAppCall,
} from '@/agent/lib/agent-app-call'

const CALL_ID = 'call-1'
const DEVICE_A = 'ios-installation-a'
const DEVICE_B = 'ios-installation-b'
let row: CallRow | null

function matchesWhere(where: Record<string, unknown>): boolean {
  if (!row || where.id !== row.id) return false
  if (typeof where.status === 'string' && where.status !== row.status) return false
  if ('answeringDeviceId' in where && where.answeringDeviceId !== row.answeringDeviceId) return false
  if ('answeredAt' in where) {
    const expected = where.answeredAt as Date | null
    if (expected?.getTime() !== row.answeredAt?.getTime()) return false
  }
  if ('updatedAt' in where) {
    const expected = where.updatedAt as Date
    if (expected.getTime() !== row.updatedAt.getTime()) return false
  }
  return true
}

beforeEach(() => {
  vi.clearAllMocks()
  row = {
    id: CALL_ID,
    status: 'ringing',
    answeredAt: null,
    answeringDeviceId: null,
    eligibleDeviceIds: [DEVICE_A, DEVICE_B],
    claimReceiptHash: null,
    endedAt: null,
    summary: null,
    createdAt: new Date(),
    updatedAt: new Date('2026-08-11T00:00:00.000Z'),
    source: 'salah',
    purpose: 'test purpose',
  }
  mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    row && row.id === where.id ? { ...row } : null)
  mocks.updateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown>
    data: Partial<CallRow>
  }) => {
    if (!matchesWhere(where)) return { count: 0 }
    row = { ...row!, ...data, updatedAt: new Date(row!.updatedAt.getTime() + 1) }
    return { count: 1 }
  })
  mocks.ownerFindMany.mockResolvedValue([])
  mocks.getDevices.mockResolvedValue([])
  mocks.getLegacy.mockResolvedValue({ voip: [], fcm: [] })
  mocks.sendVoip.mockResolvedValue([])
  mocks.sendFcm.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Agent app-call monotonic device-owned transitions', () => {
  it('has a deterministic legacy-v1 sunset boundary', () => {
    expect(agentAppCallLegacyV1Allowed(new Date('2026-09-14T23:59:59.999Z'))).toBe(true)
    expect(agentAppCallLegacyV1Allowed(new Date(AGENT_APP_CALL_LEGACY_V1_SUNSET_AT))).toBe(false)
    expect(agentAppCallLegacyV1Allowed(
      new Date('2026-08-11T00:00:00.000Z'),
      'not-a-date',
    )).toBe(false)
  })

  it('closes ringing -> failed truthfully for a technical startup failure', async () => {
    const result = await markAgentAppCall(CALL_ID, {
      status: 'failed',
      deviceId: DEVICE_A,
      summary: '[device] microphone permission denied',
    })

    expect(result).toMatchObject({ ok: true, changed: true, status: 'failed' })
    expect(row).toMatchObject({
      status: 'failed',
      answeredAt: null,
      summary: '[device] microphone permission denied',
    })
    expect(row?.endedAt).toBeInstanceOf(Date)
  })

  it.each(['failed', 'completed'] as const)(
    'allows the answering installation to close answered -> %s',
    async (terminal) => {
      await expect(markAgentAppCall(CALL_ID, {
        status: 'answered',
        deviceId: DEVICE_A,
      })).resolves.toMatchObject({ ok: true, changed: true, status: 'answered' })

      expect(row).toMatchObject({ status: 'answered', answeringDeviceId: DEVICE_A })
      await expect(markAgentAppCall(CALL_ID, {
        status: terminal,
        deviceId: DEVICE_A,
      })).resolves.toMatchObject({ ok: true, changed: true, status: terminal })
      expect(row).toMatchObject({ status: terminal, answeringDeviceId: DEVICE_A })
    },
  )

  it.each(['failed', 'completed'] as const)(
    'rejects a foreign installation trying to post %s after answer without mutation',
    async (terminal) => {
      await markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
      const before = { ...row }

      await expect(markAgentAppCall(CALL_ID, {
        status: terminal,
        deviceId: DEVICE_B,
      })).resolves.toMatchObject({
        ok: false,
        changed: false,
        error: 'device_mismatch',
        retryable: false,
        status: 'answered',
      })
      expect(row).toEqual(before)
    },
  )

  it('keeps the answer winner active when another ringing device declines late', async () => {
    await markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
    const answered = { ...row }

    await expect(markAgentAppCall(CALL_ID, {
      status: 'declined',
      deviceId: DEVICE_B,
    })).resolves.toMatchObject({ ok: false, error: 'device_mismatch', status: 'answered' })
    expect(row).toEqual(answered)

    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: true, status: 'completed' })
  })

  it('is idempotent and monotonic across retry reordering', async () => {
    await markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: true, changed: false, idempotent: true, status: 'answered' })
    await markAgentAppCall(CALL_ID, { status: 'failed', deviceId: DEVICE_A })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      superseded: true,
      status: 'failed',
    })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: false, error: 'terminal_conflict', status: 'failed' })
    expect(row?.status).toBe('failed')
  })

  it('fails closed for a legacy ownerless answered row unless the reset is trusted', async () => {
    row = {
      ...row!,
      status: 'answered',
      answeredAt: new Date('2026-08-11T00:00:00.000Z'),
      answeringDeviceId: null,
    }

    await expect(markAgentAppCall(CALL_ID, {
      status: 'failed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: false, error: 'ownership_missing', status: 'answered' })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'failed',
      trustedServerReset: true,
    })).resolves.toMatchObject({ ok: true, changed: true, status: 'failed' })
  })

  it('atomically chooses one concurrent answer owner', async () => {
    const [a, b] = await Promise.all([
      markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A }),
      markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_B }),
    ])

    const winner = a.ok ? DEVICE_A : DEVICE_B
    const loser = a.ok ? b : a
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(row).toMatchObject({ status: 'answered', answeringDeviceId: winner })
    expect(loser).toMatchObject({ ok: false, error: 'device_mismatch', status: 'answered' })
  })

  it('allows explicit legacy migration of ownerless rows but never closes a v2-owned row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'))
    const legacyDevice = legacyAgentAppCallDeviceId('owner-1')
    expect(Date.parse(AGENT_APP_CALL_LEGACY_V1_SUNSET_AT)).toBeGreaterThan(Date.parse('2026-08-11'))
    row = {
      ...row!,
      status: 'answered',
      answeredAt: new Date('2026-08-11T00:00:00.000Z'),
      answeringDeviceId: null,
    }

    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: false, error: 'ownership_missing' })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: legacyDevice,
      legacyV1: true,
    })).resolves.toMatchObject({ ok: true, changed: true, status: 'completed' })
    expect(row?.answeringDeviceId).toBe(legacyDevice)

    row = {
      ...row!,
      status: 'answered',
      endedAt: null,
      answeringDeviceId: DEVICE_A,
    }
    await expect(markAgentAppCall(CALL_ID, {
      status: 'failed',
      deviceId: legacyDevice,
      legacyV1: true,
    })).resolves.toMatchObject({ ok: false, error: 'device_mismatch', status: 'answered' })
    expect(row).toMatchObject({ status: 'answered', answeringDeviceId: DEVICE_A })
  })

  it('accepts legacy completed-before-answered reordering but keeps v2 strict', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'))
    const legacyDevice = legacyAgentAppCallDeviceId('owner-1')

    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: false, error: 'invalid_transition', status: 'ringing' })

    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: legacyDevice,
      legacyV1: true,
    })).resolves.toMatchObject({ ok: true, changed: true, status: 'completed' })
    expect(row).toMatchObject({
      status: 'completed',
      answeringDeviceId: legacyDevice,
      answeredAt: expect.any(Date),
      endedAt: expect.any(Date),
    })

    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: legacyDevice,
      legacyV1: true,
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      superseded: true,
      status: 'completed',
    })
  })

  it('rejects the reserved legacy identity namespace from a v2 caller', async () => {
    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: legacyAgentAppCallDeviceId('owner-1'),
    })).resolves.toMatchObject({ ok: false, error: 'device_id_required' })
    expect(row?.status).toBe('ringing')
  })

  it('binds a v2 ringing transition to the immutable delivery snapshot', async () => {
    row = { ...row!, eligibleDeviceIds: [DEVICE_A] }

    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_B,
    })).resolves.toMatchObject({
      ok: false,
      error: 'claim_receipt_required',
      retryable: false,
      status: 'ringing',
    })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: true, status: 'answered' })

    // Registry rotation after ring dispatch cannot revoke the winner: exact
    // durable answer ownership, not mutable current registration, fences end.
    row = { ...row!, eligibleDeviceIds: [] }
    await expect(markAgentAppCall(CALL_ID, {
      status: 'completed',
      deviceId: DEVICE_A,
    })).resolves.toMatchObject({ ok: true, status: 'completed' })
  })

  it('accepts an upgraded legacy-target recipient only with this ring bearer receipt', async () => {
    const receipt = Buffer.alloc(32, 7).toString('base64url')
    row = {
      ...row!,
      eligibleDeviceIds: [],
      claimReceiptHash: createHash('sha256').update(receipt).digest('hex'),
    }

    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_A,
      claimReceipt: `${receipt.slice(0, -1)}x`,
    })).resolves.toMatchObject({ ok: false, error: 'claim_receipt_required' })
    await expect(markAgentAppCall(CALL_ID, {
      status: 'answered',
      deviceId: DEVICE_A,
      claimReceipt: receipt,
    })).resolves.toMatchObject({ ok: true, status: 'answered' })
  })

  it('re-reads the durable answer winner when stale-ring expiry loses its CAS', async () => {
    row = { ...row!, createdAt: new Date(Date.now() - 120_000) }
    mocks.updateMany.mockImplementationOnce(async () => {
      row = {
        ...row!,
        status: 'answered',
        answeredAt: new Date(),
        answeringDeviceId: DEVICE_A,
      }
      return { count: 0 }
    })

    await expect(getAgentAppCallStatus(CALL_ID)).resolves.toBe('answered')
    expect(mocks.sendVoip).not.toHaveBeenCalled()
  })

  it('awaits cancellation delivery before returning an accepted ringing exit', async () => {
    let release!: (value: Array<{ token: string; ok: boolean }>) => void
    const delivery = new Promise<Array<{ token: string; ok: boolean }>>((resolve) => { release = resolve })
    mocks.ownerFindMany.mockResolvedValue([{ id: 'owner-1' }])
    mocks.getDevices.mockResolvedValue([{
      id: 'device-a', provider: 'apns_voip', environment: 'sandbox', token: 'a'.repeat(64),
    }])
    mocks.sendVoip.mockReturnValue(delivery)

    let settled = false
    const transition = markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
      .then((result) => { settled = true; return result })
    await vi.waitFor(() => expect(mocks.sendVoip).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release([{ token: 'a'.repeat(64), ok: true }])
    await expect(transition).resolves.toMatchObject({ ok: true, status: 'answered' })
  })

  it('awaits expiry cancellation and returns unanswered only after delivery settles', async () => {
    row = { ...row!, createdAt: new Date(Date.now() - 120_000), source: 'salah' }
    let release!: (value: Array<{ token: string; ok: boolean }>) => void
    const delivery = new Promise<Array<{ token: string; ok: boolean }>>((resolve) => { release = resolve })
    mocks.ownerFindMany.mockResolvedValue([{ id: 'owner-1' }])
    mocks.getDevices.mockResolvedValue([{
      id: 'device-a', provider: 'apns_voip', environment: 'sandbox', token: 'b'.repeat(64),
    }])
    mocks.sendVoip.mockReturnValue(delivery)

    let settled = false
    const expiry = getAgentAppCallStatus(CALL_ID).then((status) => { settled = true; return status })
    await vi.waitFor(() => expect(mocks.sendVoip).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release([{ token: 'b'.repeat(64), ok: true }])
    await expect(expiry).resolves.toBe('unanswered')
  })

  it('appends diagnostics only for the durable answer owner', async () => {
    await markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
    row = { ...row!, summary: 'existing summary' }

    await expect(appendAgentAppCallDeviceNote(CALL_ID, {
      deviceId: DEVICE_B,
      note: 'foreign note',
    })).resolves.toMatchObject({ ok: false, error: 'device_mismatch' })
    expect(row?.summary).toBe('existing summary')

    await expect(appendAgentAppCallDeviceNote(CALL_ID, {
      deviceId: DEVICE_A,
      note: 'owned note',
    })).resolves.toMatchObject({ ok: true, changed: true })
    expect(row?.summary).toBe('existing summary\n[device] owned note')
  })

  it('retains newest complete diagnostic lines when the summary cap is reached', async () => {
    await markAgentAppCall(CALL_ID, { status: 'answered', deviceId: DEVICE_A })
    row = {
      ...row!,
      summary: `${'old'.repeat(1500)}\n[device] recent one\n[device] recent two`,
    }

    await expect(appendAgentAppCallDeviceNote(CALL_ID, {
      deviceId: DEVICE_A,
      note: 'newest',
    })).resolves.toMatchObject({ ok: true, changed: true })
    expect(row?.summary).not.toContain('oldoldold')
    expect(row?.summary).toContain('[device] recent one')
    expect(row?.summary).toContain('[device] recent two')
    expect(row?.summary).toMatch(/\[device\] newest$/)
    expect(row!.summary!.length).toBeLessThanOrEqual(4000)
  })
})
