import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { OFFICE_CALL_TIMING } from '@/agent/lib/office-call-observability'

export const OFFICE_CALL_STATES = [
  'CREATED',
  'RINGING',
  'ANSWERED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'ENDED',
] as const

export const OFFICE_CALL_TERMINAL_REASONS = [
  'DECLINED',
  'CANCELLED',
  'MISSED',
  'COMPLETED',
  'FAILED',
  'BUSY',
  'PUSH_UNREACHABLE',
] as const

export type OfficeCallStateValue = (typeof OFFICE_CALL_STATES)[number]
export type OfficeCallTerminalReasonValue = (typeof OFFICE_CALL_TERMINAL_REASONS)[number]
export type OfficeCallActorRole = 'caller' | 'callee' | 'server'

export type OfficeCallTransitionDecision =
  | { ok: true; idempotent: boolean }
  | { ok: false; error: 'illegal_transition' | 'terminal_reason_required' | 'terminal_reason_forbidden' | 'actor_forbidden' }

const FORWARD: Record<Exclude<OfficeCallStateValue, 'ENDED'>, readonly OfficeCallStateValue[]> = {
  CREATED: ['RINGING', 'ENDED'],
  RINGING: ['ANSWERED', 'ENDED'],
  ANSWERED: ['CONNECTING', 'ENDED'],
  CONNECTING: ['CONNECTED', 'RECONNECTING', 'ENDED'],
  CONNECTED: ['RECONNECTING', 'ENDED'],
  RECONNECTING: ['CONNECTED', 'ENDED'],
}

/** Pure transition policy: clients request facts; the server is the only writer. */
export function decideOfficeCallTransition(args: {
  current: OfficeCallStateValue
  target: OfficeCallStateValue
  actor: OfficeCallActorRole
  reason?: OfficeCallTerminalReasonValue | null
}): OfficeCallTransitionDecision {
  if (args.current === args.target) {
    if (args.target === 'ENDED' && !args.reason) return { ok: false, error: 'terminal_reason_required' }
    return { ok: true, idempotent: true }
  }
  if (args.current === 'ENDED' || !FORWARD[args.current].includes(args.target)) {
    return { ok: false, error: 'illegal_transition' }
  }
  if (args.target === 'ENDED' && !args.reason) return { ok: false, error: 'terminal_reason_required' }
  if (args.target !== 'ENDED' && args.reason) return { ok: false, error: 'terminal_reason_forbidden' }

  if (args.current === 'CREATED' && args.target === 'RINGING' && args.actor !== 'server') {
    return { ok: false, error: 'actor_forbidden' }
  }
  if (args.current === 'RINGING' && args.target === 'ANSWERED' && args.actor !== 'callee') {
    return { ok: false, error: 'actor_forbidden' }
  }
  if (args.target === 'ENDED') {
    const allowed =
      args.actor === 'server'
        ? ['MISSED', 'FAILED', 'PUSH_UNREACHABLE', 'COMPLETED']
        : args.actor === 'caller'
          ? args.current === 'RINGING'
            ? ['CANCELLED']
            : ['COMPLETED', 'FAILED']
          : args.current === 'RINGING'
            ? ['DECLINED']
            : ['COMPLETED', 'FAILED']
    if (!allowed.includes(args.reason!)) return { ok: false, error: 'actor_forbidden' }
  }
  return { ok: true, idempotent: false }
}

export function isCanonicalOfficeCallEnabled(): boolean {
  return process.env.OFFICE_CALL_SESSIONS_ENABLED === 'true'
}

/** Stable non-zero 31-bit Agora UID, unique for the two roles in a call. */
export function stableOfficeCallAgoraUid(callId: string, userId: string, role: 'CALLER' | 'CALLEE'): number {
  const digest = createHash('sha256').update(`${callId}:${role}:${userId}`).digest()
  return (digest.readUInt32BE(0) & 0x7fffffff) || (role === 'CALLER' ? 1 : 2)
}

function hasBusinessAccess(raw: string, businessId: string): boolean {
  return raw.split(',').map((value) => value.trim()).filter(Boolean).includes(businessId)
}

/** Business-scoped owner resolution; never chooses a global unrelated SUPER_ADMIN. */
export async function resolveBusinessOwnerUserId(businessId: string): Promise<string | null> {
  const owners = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', active: true, businessAccess: { contains: businessId } },
    select: { id: true, businessAccess: true },
    orderBy: { createdAt: 'asc' },
  })
  return owners.find((owner) => hasBusinessAccess(owner.businessAccess, businessId))?.id ?? null
}

type CreateCanonicalArgs = {
  businessId: string
  callerUserId: string
  calleeUserId: string
  targetStaffId?: string | null
  receiptStaffIds: string[]
  callerName: string
  clientRequestId?: string | null
}

export type CreateCanonicalResult =
  | { ok: true; id: string; createdAt: string; idempotent: boolean }
  | { ok: false; error: 'busy' | 'idempotency_conflict' | 'invalid_participants' }

function isUniqueError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function isSerializableConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2034')
}

/**
 * Creates canonical session, logical legs, participant locks, delivery outbox,
 * legacy feed projection, and initial events in one Serializable transaction.
 */
export async function createCanonicalOfficeCall(args: CreateCanonicalArgs): Promise<CreateCanonicalResult> {
  if (!args.callerUserId || !args.calleeUserId || args.callerUserId === args.calleeUserId) {
    return { ok: false, error: 'invalid_participants' }
  }
  const requestId = args.clientRequestId?.trim() || null
  if (requestId) {
    const prior = await prisma.officeCallSession.findUnique({
      where: {
        businessId_callerUserId_clientRequestId: {
          businessId: args.businessId,
          callerUserId: args.callerUserId,
          clientRequestId: requestId,
        },
      },
      select: { id: true, calleeUserId: true, createdAt: true },
    })
    if (prior) {
      if (prior.calleeUserId !== args.calleeUserId) return { ok: false, error: 'idempotency_conflict' }
      return { ok: true, id: prior.id, createdAt: prior.createdAt.toISOString(), idempotent: true }
    }
  }

  const callId = randomUUID()
  const now = new Date()
  const ringExpiresAt = new Date(now.getTime() + OFFICE_CALL_TIMING.ringTimeoutMs)
  const maxEndsAt = new Date(now.getTime() + OFFICE_CALL_TIMING.maxCallDurationMs)
  const agoraChannel = `itc_${callId}`
  const callerUid = stableOfficeCallAgoraUid(callId, args.callerUserId, 'CALLER')
  let calleeUid = stableOfficeCallAgoraUid(callId, args.calleeUserId, 'CALLEE')
  if (calleeUid === callerUid) calleeUid = callerUid === 0x7fffffff ? callerUid - 1 : callerUid + 1

  try {
    let created: { id: string; createdAt: Date } | null = null
    // PostgreSQL may abort one Serializable transaction during a legitimate
    // race. Retry the whole atomic create; participant locks still decide busy.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        created = await prisma.$transaction(
          async (tx) => {
        const session = await tx.officeCallSession.create({
          data: {
            id: callId,
            businessId: args.businessId,
            callerUserId: args.callerUserId,
            calleeUserId: args.calleeUserId,
            targetStaffId: args.targetStaffId ?? null,
            legacyBroadcastId: callId,
            clientRequestId: requestId,
            agoraChannel,
            state: 'RINGING',
            ringExpiresAt,
            maxEndsAt,
            legs: {
              create: [
                { participantUserId: args.callerUserId, role: 'CALLER', state: 'RINGING', agoraUid: callerUid },
                { participantUserId: args.calleeUserId, role: 'CALLEE', state: 'RINGING', agoraUid: calleeUid },
              ],
            },
            participantLocks: {
              create: [
                { userId: args.callerUserId, businessId: args.businessId },
                { userId: args.calleeUserId, businessId: args.businessId },
              ],
            },
            outbox: {
              create: {
                targetUserId: args.calleeUserId,
                kind: 'call.ring',
                idempotencyKey: `${callId}:ring:${args.calleeUserId}`,
                payload: {
                  schemaVersion: 1,
                  event: 'ring',
                  callId,
                  callUUID: callId,
                  channel: agoraChannel,
                  callerName: args.callerName,
                  expiresAt: ringExpiresAt.toISOString(),
                },
              },
            },
          },
          select: { id: true, createdAt: true },
        })
        await tx.officeIntercomBroadcast.create({
          data: {
            id: callId,
            businessId: args.businessId,
            senderUserId: args.callerUserId,
            kind: 'call',
            targetStaffId: args.targetStaffId ?? null,
            targetUserId: args.calleeUserId,
            callerName: args.callerName,
            receipts: { create: args.receiptStaffIds.map((staffId) => ({ staffId })) },
          },
        })
        await tx.officeCallEvent.createMany({
          data: [
            {
              callId,
              businessId: args.businessId,
              actorUserId: args.callerUserId,
              source: 'server',
              event: 'call.created',
              state: 'created',
              metadata: { protocolVersion: 1 },
              occurredAt: now,
            },
            {
              callId,
              businessId: args.businessId,
              actorUserId: args.callerUserId,
              source: 'server',
              event: 'call.transition',
              state: 'ringing',
              metadata: { from: 'CREATED', to: 'RINGING', version: 0 },
              occurredAt: now,
            },
          ],
        })
        return session
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        )
        break
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === 3) throw error
      }
    }
    if (!created) throw new Error('office_call_create_transaction_exhausted')
    return { ok: true, id: created.id, createdAt: created.createdAt.toISOString(), idempotent: false }
  } catch (error) {
    if (isUniqueError(error)) {
      if (requestId) {
        const prior = await prisma.officeCallSession.findUnique({
          where: {
            businessId_callerUserId_clientRequestId: {
              businessId: args.businessId,
              callerUserId: args.callerUserId,
              clientRequestId: requestId,
            },
          },
          select: { id: true, calleeUserId: true, createdAt: true },
        })
        if (prior) {
          if (prior.calleeUserId !== args.calleeUserId) return { ok: false, error: 'idempotency_conflict' }
          return { ok: true, id: prior.id, createdAt: prior.createdAt.toISOString(), idempotent: true }
        }
      }
      return { ok: false, error: 'busy' }
    }
    throw error
  }
}

export type TransitionCanonicalResult =
  | { ok: true; state: OfficeCallStateValue; version: number; alreadyApplied: boolean; terminalReason: OfficeCallTerminalReasonValue | null }
  | {
      ok: false
      error:
        | 'not_found'
        | 'forbidden'
        | 'version_conflict'
        | 'illegal_transition'
        | 'terminal_reason_required'
        | 'terminal_reason_forbidden'
        | 'actor_forbidden'
    }

export async function transitionCanonicalOfficeCall(args: {
  callId: string
  businessId: string
  actorUserId?: string | null
  actorRole?: OfficeCallActorRole
  target: OfficeCallStateValue
  reason?: OfficeCallTerminalReasonValue | null
  expectedVersion?: number | null
  now?: Date
}): Promise<TransitionCanonicalResult> {
  const now = args.now ?? new Date()
  return prisma.$transaction(
    async (tx) => {
      const session = await tx.officeCallSession.findFirst({
        where: { id: args.callId, businessId: args.businessId },
      })
      if (!session) return { ok: false, error: 'not_found' } as const
      let actor: OfficeCallActorRole
      if (args.actorRole === 'server') actor = 'server'
      else if (args.actorUserId === session.callerUserId) actor = 'caller'
      else if (args.actorUserId === session.calleeUserId) actor = 'callee'
      else return { ok: false, error: 'forbidden' } as const

      let target = args.target
      let reason = args.reason ?? null
      if (session.state === 'RINGING' && now >= session.ringExpiresAt) {
        actor = 'server'
        target = 'ENDED'
        reason = 'MISSED'
      } else if (session.state !== 'ENDED' && now >= session.maxEndsAt) {
        actor = 'server'
        target = 'ENDED'
        reason = 'COMPLETED'
      }

      const decision = decideOfficeCallTransition({
        current: session.state as OfficeCallStateValue,
        target,
        actor,
        reason: reason as OfficeCallTerminalReasonValue | null,
      })
      if (!decision.ok) return decision
      if (decision.idempotent) {
        return {
          ok: true,
          state: session.state as OfficeCallStateValue,
          version: session.version,
          alreadyApplied: true,
          terminalReason: session.terminalReason as OfficeCallTerminalReasonValue | null,
        } as const
      }
      if (args.expectedVersion != null && args.expectedVersion !== session.version) {
        return { ok: false, error: 'version_conflict' } as const
      }

      const nextVersion = session.version + 1
      const changed = await tx.officeCallSession.updateMany({
        where: { id: session.id, version: session.version, state: session.state },
        data: {
          state: target,
          version: { increment: 1 },
          terminalReason: target === 'ENDED' ? reason : null,
          answeredAt: target === 'ANSWERED' ? now : undefined,
          connectedAt: target === 'CONNECTED' ? session.connectedAt ?? now : undefined,
          endedAt: target === 'ENDED' ? now : undefined,
        },
      })
      if (changed.count !== 1) return { ok: false, error: 'version_conflict' } as const

      if (target === 'ENDED') {
        await tx.officeCallLeg.updateMany({ where: { callId: session.id }, data: { state: 'ENDED', leftAt: now } })
        await tx.officeCallParticipantLock.deleteMany({ where: { callId: session.id } })
        // Server expiry must also close the existing feed/history projection;
        // otherwise legacy clients can keep ringing after canonical termination.
        await tx.officeIntercomBroadcast.updateMany({
          where: { id: session.legacyBroadcastId ?? session.id, endedAt: null },
          data: { endedAt: now, endedReason: reason?.toLowerCase() ?? 'failed' },
        })
        await tx.officeCallOutbox.createMany({
          data: [session.callerUserId, session.calleeUserId].map((targetUserId) => ({
            callId: session.id,
            targetUserId,
            kind: 'call.cancel',
            idempotencyKey: `${session.id}:cancel:${targetUserId}`,
            payload: {
              schemaVersion: 1,
              event: 'cancel',
              callId: session.id,
              callUUID: session.id,
              channel: session.agoraChannel,
              reason: reason?.toLowerCase() ?? 'failed',
            },
          })),
          skipDuplicates: true,
        })
      } else if (actor !== 'server' && args.actorUserId) {
        await tx.officeCallLeg.updateMany({
          where: { callId: session.id, participantUserId: args.actorUserId },
          data: {
            state: target,
            joinedAt: ['CONNECTING', 'CONNECTED'].includes(target) ? now : undefined,
          },
        })
      }
      await tx.officeCallEvent.create({
        data: {
          callId: session.id,
          businessId: session.businessId,
          actorUserId: args.actorUserId ?? null,
          source: 'server',
          event: 'call.transition',
          state: target.toLowerCase(),
          metadata: {
            from: session.state,
            to: target,
            actor,
            version: nextVersion,
            ...(reason ? { reason } : {}),
          },
          occurredAt: now,
        },
      })
      return { ok: true, state: target, version: nextVersion, alreadyApplied: false, terminalReason: reason } as const
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

export async function getCanonicalOfficeCallForParticipant(args: {
  callId: string
  businessId: string
  userId: string
}) {
  return prisma.officeCallSession.findFirst({
    where: {
      id: args.callId,
      businessId: args.businessId,
      OR: [{ callerUserId: args.userId }, { calleeUserId: args.userId }],
    },
    include: { legs: true },
  })
}

export async function authorizeCanonicalAgoraLeg(args: {
  callId: string
  businessId: string
  userId: string
  channel: string
}): Promise<{ ok: true; uid: number; peerUid: number } | { ok: false; error: 'call_forbidden' | 'call_ended' | 'channel_mismatch' }> {
  let session = await getCanonicalOfficeCallForParticipant(args)
  if (!session) return { ok: false, error: 'call_forbidden' }
  if (session.agoraChannel !== args.channel) return { ok: false, error: 'channel_mismatch' }
  const now = new Date()
  if (session.state !== 'ENDED' && (now >= session.ringExpiresAt || now >= session.maxEndsAt)) {
    await transitionCanonicalOfficeCall({
      callId: session.id,
      businessId: session.businessId,
      actorRole: 'server',
      target: session.state as OfficeCallStateValue,
      now,
    })
    session = await getCanonicalOfficeCallForParticipant(args)
    if (!session) return { ok: false, error: 'call_forbidden' }
  }
  if (session.state === 'ENDED') return { ok: false, error: 'call_ended' }
  const leg = session.legs.find((candidate) => candidate.participantUserId === args.userId)
  if (!leg) return { ok: false, error: 'call_forbidden' }
  const peer = session.legs.find((candidate) => candidate.participantUserId !== args.userId)
  if (!peer) return { ok: false, error: 'call_forbidden' }
  return { ok: true, uid: leg.agoraUid, peerUid: peer.agoraUid }
}

/** Bounded server sweep for calls whose authoritative deadlines elapsed. */
export async function reconcileExpiredOfficeCalls(args: { now?: Date; limit?: number } = {}) {
  const now = args.now ?? new Date()
  const limit = Math.min(200, Math.max(1, args.limit ?? 100))
  const expired = await prisma.officeCallSession.findMany({
    where: {
      state: { not: 'ENDED' },
      OR: [{ ringExpiresAt: { lte: now } }, { maxEndsAt: { lte: now } }],
    },
    select: { id: true, businessId: true, state: true },
    orderBy: { ringExpiresAt: 'asc' },
    take: limit,
  })
  const outcomes = await Promise.all(
    expired.map((session) =>
      transitionCanonicalOfficeCall({
        callId: session.id,
        businessId: session.businessId,
        actorRole: 'server',
        target: session.state as OfficeCallStateValue,
        now,
      }),
    ),
  )
  return {
    examined: expired.length,
    ended: outcomes.filter((outcome) => outcome.ok && outcome.state === 'ENDED' && !outcome.alreadyApplied).length,
    conflicts: outcomes.filter((outcome) => !outcome.ok && outcome.error === 'version_conflict').length,
  }
}
