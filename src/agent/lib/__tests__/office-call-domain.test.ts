import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  userFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    officeCallSession: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      count: mocks.count,
    },
    user: { findMany: mocks.userFindMany },
  },
}))

import {
  createCanonicalOfficeCall,
  decideOfficeCallTransition,
  OFFICE_CALL_STATES,
  authorizeCanonicalAgoraLeg,
  resolveBusinessOwnerUserId,
  stableOfficeCallAgoraUid,
  transitionCanonicalOfficeCall,
  type OfficeCallStateValue,
} from '@/agent/lib/office-call-domain'

const allowed: Record<OfficeCallStateValue, OfficeCallStateValue[]> = {
  CREATED: ['CREATED', 'RINGING', 'ENDED'],
  RINGING: ['RINGING', 'ANSWERED', 'ENDED'],
  ANSWERED: ['ANSWERED', 'CONNECTING', 'ENDED'],
  CONNECTING: ['CONNECTING', 'CONNECTED', 'RECONNECTING', 'ENDED'],
  CONNECTED: ['CONNECTED', 'RECONNECTING', 'ENDED'],
  RECONNECTING: ['RECONNECTING', 'CONNECTED', 'ENDED'],
  ENDED: ['ENDED'],
}

describe('office call transition policy', () => {
  it('rejects every state edge outside the explicit table', () => {
    for (const current of OFFICE_CALL_STATES) {
      for (const target of OFFICE_CALL_STATES) {
        if (allowed[current].includes(target)) continue
        expect(
          decideOfficeCallTransition({ current, target, actor: 'server', reason: target === 'ENDED' ? 'FAILED' : null }),
          `${current} -> ${target}`,
        ).toEqual({ ok: false, error: 'illegal_transition' })
      }
    }
  })

  it('allows only the callee to answer a ringing call', () => {
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ANSWERED', actor: 'callee' })).toEqual({ ok: true, idempotent: false })
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ANSWERED', actor: 'caller' })).toEqual({ ok: false, error: 'actor_forbidden' })
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ANSWERED', actor: 'server' })).toEqual({ ok: false, error: 'actor_forbidden' })
  })

  it('enforces actor-specific terminal reasons and server-owned timeout', () => {
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ENDED', actor: 'caller', reason: 'CANCELLED' })).toEqual({ ok: true, idempotent: false })
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ENDED', actor: 'callee', reason: 'DECLINED' })).toEqual({ ok: true, idempotent: false })
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ENDED', actor: 'server', reason: 'MISSED' })).toEqual({ ok: true, idempotent: false })
    expect(decideOfficeCallTransition({ current: 'RINGING', target: 'ENDED', actor: 'caller', reason: 'MISSED' })).toEqual({ ok: false, error: 'actor_forbidden' })
  })

  it('requires terminal reason, forbids it on non-terminal edges, and is idempotent', () => {
    expect(decideOfficeCallTransition({ current: 'CONNECTED', target: 'ENDED', actor: 'caller' })).toEqual({ ok: false, error: 'terminal_reason_required' })
    expect(decideOfficeCallTransition({ current: 'ANSWERED', target: 'CONNECTING', actor: 'caller', reason: 'FAILED' })).toEqual({ ok: false, error: 'terminal_reason_forbidden' })
    expect(decideOfficeCallTransition({ current: 'CONNECTED', target: 'CONNECTED', actor: 'callee' })).toEqual({ ok: true, idempotent: true })
  })
})

describe('office call domain persistence guards', () => {
  beforeEach(() => {
    mocks.transaction.mockReset()
    mocks.findUnique.mockReset()
    mocks.findFirst.mockReset()
    mocks.findMany.mockReset()
    mocks.count.mockReset().mockResolvedValue(0)
    mocks.userFindMany.mockReset()
  })

  it('allocates stable, non-zero, participant-distinct Agora UIDs', () => {
    const caller = stableOfficeCallAgoraUid('call-a', 'user-a', 'CALLER')
    const callee = stableOfficeCallAgoraUid('call-a', 'user-b', 'CALLEE')
    expect(caller).toBeGreaterThan(0)
    expect(callee).toBeGreaterThan(0)
    expect(caller).not.toBe(callee)
    expect(stableOfficeCallAgoraUid('call-a', 'user-a', 'CALLER')).toBe(caller)
  })

  it('resolves only a SUPER_ADMIN with exact business membership', async () => {
    mocks.userFindMany.mockResolvedValue([
      { id: 'false-positive', businessAccess: 'NOT_ALMA_LIFESTYLE_X' },
      { id: 'right-owner', businessAccess: 'ALMA_TRADING, ALMA_LIFESTYLE' },
    ])
    await expect(resolveBusinessOwnerUserId('ALMA_LIFESTYLE')).resolves.toBe('right-owner')
  })

  it('maps a participant-lock uniqueness collision to busy with no partial call', async () => {
    mocks.findUnique.mockResolvedValue(null)
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate participant lock', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['user_id'] },
      }),
    )
    await expect(
      createCanonicalOfficeCall({
        businessId: 'ALMA_LIFESTYLE',
        callerUserId: 'caller',
        calleeUserId: 'callee',
        receiptStaffIds: [],
        callerName: 'Caller',
      }),
    ).resolves.toEqual({ ok: false, error: 'busy' })
  })

  it('retries a Serializable create conflict up to the successful transaction', async () => {
    mocks.findUnique.mockResolvedValue(null)
    const conflict = new Prisma.PrismaClientKnownRequestError('serialization failure', {
      code: 'P2034',
      clientVersion: '5.22.0',
    })
    mocks.transaction
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: 'call-retried', createdAt: new Date('2026-07-17T12:00:00.000Z') })
    await expect(
      createCanonicalOfficeCall({
        businessId: 'ALMA_LIFESTYLE',
        callerUserId: 'caller',
        calleeUserId: 'callee',
        receiptStaffIds: [],
        callerName: 'Caller',
      }),
    ).resolves.toEqual({
      ok: true,
      id: 'call-retried',
      createdAt: '2026-07-17T12:00:00.000Z',
      idempotent: false,
    })
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
  })

  it('returns the original call for an idempotent duplicate create request', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'existing-call',
      calleeUserId: 'callee',
      createdAt: new Date('2026-07-17T13:00:00.000Z'),
    })
    await expect(
      createCanonicalOfficeCall({
        businessId: 'ALMA_LIFESTYLE',
        callerUserId: 'caller',
        calleeUserId: 'callee',
        receiptStaffIds: [],
        callerName: 'Caller',
        clientRequestId: 'request-12345678',
      }),
    ).resolves.toEqual({
      ok: true,
      id: 'existing-call',
      createdAt: '2026-07-17T13:00:00.000Z',
      idempotent: true,
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('rejects Agora authorization for a non-participant or wrong business', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await expect(
      authorizeCanonicalAgoraLeg({
        callId: 'call-secret',
        businessId: 'ALMA_TRADING',
        userId: 'unrelated-user',
        channel: 'itc_call-secret',
      }),
    ).resolves.toEqual({ ok: false, error: 'call_forbidden' })
  })

  it('lets exactly one device win a concurrent answer CAS', async () => {
    const session = {
      id: 'call-answer',
      businessId: 'ALMA_LIFESTYLE',
      callerUserId: 'caller',
      calleeUserId: 'callee',
      state: 'RINGING',
      terminalReason: null,
      version: 0,
      ringExpiresAt: new Date(Date.now() + 60_000),
      maxEndsAt: new Date(Date.now() + 600_000),
      connectedAt: null,
    }
    let reads = 0
    let releaseReads!: () => void
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve })
    let claimed = false
    const tx = {
      officeCallSession: {
        findFirst: vi.fn(async () => {
          reads += 1
          if (reads === 2) releaseReads()
          await bothRead
          return { ...session }
        }),
        updateMany: vi.fn(async () => {
          if (claimed) return { count: 0 }
          claimed = true
          return { count: 1 }
        }),
      },
      officeCallLeg: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      officeCallEvent: { create: vi.fn().mockResolvedValue({}) },
    }
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx))
    const results = await Promise.all([
      transitionCanonicalOfficeCall({ callId: session.id, businessId: session.businessId, actorUserId: 'callee', target: 'ANSWERED', expectedVersion: 0 }),
      transitionCanonicalOfficeCall({ callId: session.id, businessId: session.businessId, actorUserId: 'callee', target: 'ANSWERED', expectedVersion: 0 }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'version_conflict' }])
  })

  it('makes server ring expiry win over a simultaneous late answer', async () => {
    const now = new Date('2026-07-17T14:00:00.000Z')
    const tx = {
      officeCallSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'call-expired',
          businessId: 'ALMA_LIFESTYLE',
          callerUserId: 'caller',
          calleeUserId: 'callee',
          legacyBroadcastId: 'call-expired',
          agoraChannel: 'itc_call-expired',
          state: 'RINGING',
          terminalReason: null,
          version: 0,
          ringExpiresAt: new Date(now.getTime() - 1),
          maxEndsAt: new Date(now.getTime() + 600_000),
          connectedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      officeCallLeg: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeCallParticipantLock: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeIntercomBroadcast: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      officeCallOutbox: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeCallEvent: { create: vi.fn().mockResolvedValue({}) },
    }
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx))
    await expect(
      transitionCanonicalOfficeCall({
        callId: 'call-expired',
        businessId: 'ALMA_LIFESTYLE',
        actorUserId: 'callee',
        target: 'ANSWERED',
        expectedVersion: 0,
        now,
      }),
    ).resolves.toMatchObject({ ok: true, state: 'ENDED', terminalReason: 'MISSED' })
  })

  it('lets exactly one concurrent terminal CAS win', async () => {
    const session = {
      id: 'call-1',
      businessId: 'ALMA_LIFESTYLE',
      callerUserId: 'caller',
      calleeUserId: 'callee',
      state: 'CONNECTED',
      terminalReason: null,
      version: 4,
      ringExpiresAt: new Date(Date.now() + 60_000),
      maxEndsAt: new Date(Date.now() + 600_000),
      connectedAt: new Date(),
    }
    let reads = 0
    let releaseReads!: () => void
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve })
    let claimed = false
    const tx = {
      officeCallSession: {
        findFirst: vi.fn(async () => {
          reads += 1
          if (reads === 2) releaseReads()
          await bothRead
          return { ...session }
        }),
        updateMany: vi.fn(async () => {
          if (claimed) return { count: 0 }
          claimed = true
          return { count: 1 }
        }),
      },
      officeCallLeg: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeCallParticipantLock: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeIntercomBroadcast: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      officeCallOutbox: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      officeCallEvent: { create: vi.fn().mockResolvedValue({}) },
    }
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx))

    const results = await Promise.all([
      transitionCanonicalOfficeCall({ callId: 'call-1', businessId: 'ALMA_LIFESTYLE', actorUserId: 'caller', target: 'ENDED', reason: 'COMPLETED', expectedVersion: 4 }),
      transitionCanonicalOfficeCall({ callId: 'call-1', businessId: 'ALMA_LIFESTYLE', actorUserId: 'callee', target: 'ENDED', reason: 'COMPLETED', expectedVersion: 4 }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'version_conflict' }])
    expect(tx.officeCallEvent.create).toHaveBeenCalledTimes(1)
    expect(tx.officeIntercomBroadcast.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.officeCallOutbox.createMany).toHaveBeenCalledTimes(1)
  })
})
