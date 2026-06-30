import type { DrivingModeSession } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  notifyApprovalResolved,
  resolveApprovalRequest,
} from '@/lib/approvals'
import { runApprovalTransaction } from '@/lib/prisma-transaction'
import { queueAgentOutbox } from '@/lib/agent-outbox'
import { logEvent } from '@/lib/logger'

export type DrivingModeStatus = {
  enabled: boolean
  activeSession: DrivingModeSession | null
  pendingSession: DrivingModeSession | null
  canStart: boolean
  reason: string
}

export async function findDrivingModeProfile(userId: string, businessId: string) {
  return prisma.drivingModeProfile.findUnique({
    where: { userId_businessId: { userId, businessId } },
  })
}

/** Resolve the AgentStaff id for a user by name (Lifestyle), so the agent can
 *  gate follow-ups quickly. Returns null when there is no matching staff row. */
export async function resolveStaffIdForUser(userId: string, businessId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  const name = user?.name?.trim()
  if (!name) return null
  const staff = await prisma.agentStaff.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, businessId, active: true },
    select: { id: true },
  })
  return staff?.id ?? null
}

async function findOpenSession(
  userId: string,
  businessId: string,
  status: 'PENDING' | 'ACTIVE',
): Promise<DrivingModeSession | null> {
  return prisma.drivingModeSession.findFirst({
    where: { userId, businessId, status },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getDrivingModeStatus(userId: string, businessId: string): Promise<DrivingModeStatus> {
  const profile = await findDrivingModeProfile(userId, businessId)
  const [activeSession, pendingSession] = await Promise.all([
    findOpenSession(userId, businessId, 'ACTIVE'),
    findOpenSession(userId, businessId, 'PENDING'),
  ])

  if (!profile?.enabled) {
    return {
      enabled: false,
      activeSession,
      pendingSession,
      canStart: false,
      reason: profile
        ? 'Driving mode is not enabled for your account.'
        : 'Driving mode is not configured for your account.',
    }
  }
  if (activeSession) {
    return { enabled: true, activeSession, pendingSession: null, canStart: false, reason: 'You are currently in driving mode.' }
  }
  if (pendingSession) {
    return { enabled: true, activeSession: null, pendingSession, canStart: false, reason: 'Your driving mode request is awaiting approval.' }
  }
  return { enabled: true, activeSession: null, pendingSession: null, canStart: true, reason: '' }
}

export async function createDrivingModeRequest(input: {
  userId: string
  businessId: string
  employeeId: string
  reason?: string | null
  userName?: string | null
  initiatedBy?: 'staff' | 'owner'
}): Promise<{ session: DrivingModeSession; approval: { id: string } }> {
  const profile = await findDrivingModeProfile(input.userId, input.businessId)
  if (!profile?.enabled) throw new Error('Driving mode is not enabled for your account.')

  const existing = await prisma.drivingModeSession.findFirst({
    where: { userId: input.userId, businessId: input.businessId, status: { in: ['PENDING', 'ACTIVE'] } },
  })
  if (existing) {
    throw new Error(
      existing.status === 'ACTIVE'
        ? 'A driving mode session is already active.'
        : 'A driving mode request is already pending approval.',
    )
  }

  const staffId = await resolveStaffIdForUser(input.userId, input.businessId)
  const reason = (input.reason || '').trim() || 'Driving / out of office'

  const session = await prisma.drivingModeSession.create({
    data: {
      userId: input.userId,
      businessId: input.businessId,
      employeeId: input.employeeId,
      staffId,
      status: 'PENDING',
      reason,
      initiatedBy: input.initiatedBy || 'staff',
    },
  })

  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.PAYROLL,
    type: APPROVAL_TYPES.DRIVING_MODE,
    businessId: session.businessId,
    entityId: session.id,
    requestedBy: input.userId,
    reason,
    priority: 'NORMAL',
    skipNotify: false,
    actionUrl: '/approvals',
    title: 'Driving mode approval required',
    message: `${input.userName || input.employeeId}: ড্রাইভিং মোড — ${reason}`,
    payloadSnapshot: {
      userId: input.userId,
      employeeId: session.employeeId,
      staffId,
      reason,
      userName: input.userName || null,
      kind: 'driving_mode',
    },
  })

  const linked = await prisma.drivingModeSession.update({
    where: { id: session.id },
    data: { approvalId: approval.id },
  })

  return { session: linked, approval }
}

/** Owner/Admin turns a staff member's driving mode ON directly, skipping the
 *  request→approval cycle (the owner is the approver, so a self-approval is
 *  redundant). Used when a staff forgets to toggle it themselves. */
export async function startDrivingModeByOwner(input: {
  userId: string
  businessId: string
  employeeId: string
  reason?: string | null
  reviewerId: string
}): Promise<{ session: DrivingModeSession }> {
  const profile = await findDrivingModeProfile(input.userId, input.businessId)
  if (!profile?.enabled) throw new Error('Driving mode is not enabled for this staff member.')

  const existing = await prisma.drivingModeSession.findFirst({
    where: { userId: input.userId, businessId: input.businessId, status: { in: ['PENDING', 'ACTIVE'] } },
  })
  if (existing) {
    throw new Error(
      existing.status === 'ACTIVE'
        ? 'A driving mode session is already active.'
        : 'A driving mode request is already pending approval.',
    )
  }

  const staffId = await resolveStaffIdForUser(input.userId, input.businessId)
  const reason = (input.reason || '').trim() || 'Driving / out of office'
  const session = await prisma.drivingModeSession.create({
    data: {
      userId: input.userId,
      businessId: input.businessId,
      employeeId: input.employeeId,
      staffId,
      status: 'ACTIVE',
      reason,
      initiatedBy: 'owner',
      approvedAt: new Date(),
      reviewedById: input.reviewerId,
    },
  })
  logEvent('info', 'driving_mode.owner_direct_start', { userId: input.userId, businessId: input.businessId, sessionId: session.id })
  return { session }
}

export async function processDrivingModeApproval(
  approvalId: string,
  sessionId: string,
  action: 'APPROVE' | 'REJECT',
  reviewerId: string,
  note?: string,
) {
  const session = await prisma.drivingModeSession.findUnique({ where: { id: sessionId } })
  if (!session) {
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.DRIVING_MODE,
      entityId: sessionId,
      status: 'REJECTED',
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || 'Linked driving mode session missing — approval auto-closed',
    })
    dispatchApprovalsUpdated()
    return { approval, session: null, reconciled: true }
  }

  if (session.status !== 'PENDING') {
    const terminal = session.status === 'ACTIVE' ? 'APPROVED' : 'REJECTED'
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.DRIVING_MODE,
      entityId: session.id,
      status: terminal,
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || `Synced with session status ${session.status}`,
    })
    dispatchApprovalsUpdated()
    return { approval, session, reconciled: true }
  }

  const targetStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
  const result = await runApprovalTransaction(`approval.driving_mode_${action.toLowerCase()}`, async (tx) => {
    const updated = await tx.drivingModeSession.update({
      where: { id: session.id },
      data:
        action === 'APPROVE'
          ? { status: 'ACTIVE', approvedAt: new Date(), reviewedById: reviewerId }
          : { status: 'REJECTED', endedAt: new Date(), endedBy: reviewerId, reviewedById: reviewerId },
    })
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.DRIVING_MODE,
      entityId: session.id,
      status: targetStatus,
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || (action === 'APPROVE' ? 'Approved' : 'Rejected'),
      tx,
    })
    if (!approval) throw new Error('LINKAGE_BROKEN: pending approval row missing for driving mode session')
    return { updated, approval }
  })

  logEvent('info', `approval.driving_mode_${action.toLowerCase()}`, { approvalId, sessionId })
  if (result.approval) {
    await notifyApprovalResolved(result.approval, reviewerId, targetStatus, note?.slice(0, 500))
  }
  dispatchApprovalsUpdated()
  return { approval: result.approval, session: result.updated }
}

function buildWelcomeBack(name: string): string {
  const first = (name || '').trim().split(/\s+/)[0] || name || ''
  return (
    `${first} ভাই, ড্রাইভিং শেষ করলেন — আলহামদুলিল্লাহ, নিরাপদে ফিরে এসেছেন। 🤲 ` +
    `চলুন এখন আবার কাজ শুরু করি। আপনার আজকের কাজগুলো একটু একটু করে সম্পন্ন করুন; ` +
    `যতটুকু পারেন আজই করে ফেলুন, বাকি যা থাকবে সেগুলো কালকে করা যাবে ইনশাআল্লাহ।`
  )
}

/** End an active (or pending) driving session and queue the agent's warm
 *  welcome-back message to the staff so office follow-ups resume. */
export async function endDrivingModeSession(input: {
  userId: string
  businessId: string
  endedBy: string
  sendWelcomeBack?: boolean
}): Promise<{ session: DrivingModeSession | null }> {
  const session = await prisma.drivingModeSession.findFirst({
    where: { userId: input.userId, businessId: input.businessId, status: { in: ['ACTIVE', 'PENDING'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!session) return { session: null }

  const wasActive = session.status === 'ACTIVE'
  const updated = await prisma.drivingModeSession.update({
    where: { id: session.id },
    data: { status: 'ENDED', endedAt: new Date(), endedBy: input.endedBy },
  })

  // If a PENDING session is ended, also close its open approval so it does not
  // linger in the owner's queue.
  if (!wasActive && session.approvalId) {
    await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.DRIVING_MODE,
      entityId: session.id,
      status: 'REJECTED',
      actorUserId: input.endedBy,
      reason: 'Driving mode request cancelled before approval',
    }).catch(() => null)
    dispatchApprovalsUpdated()
  }

  if (wasActive && input.sendWelcomeBack !== false && !updated.welcomeBackSent) {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } })
    const name = user?.name || updated.employeeId
    let staffId = updated.staffId
    if (!staffId) staffId = await resolveStaffIdForUser(input.userId, input.businessId)
    try {
      await queueAgentOutbox({
        staffId,
        staffName: name,
        businessId: input.businessId,
        type: 'presence',
        content: buildWelcomeBack(name),
      })
      await prisma.drivingModeSession.update({ where: { id: updated.id }, data: { welcomeBackSent: true } })
    } catch (err) {
      logEvent('warn', 'driving_mode.welcome_back_failed', { sessionId: updated.id, message: (err as Error).message })
    }
  }

  return { session: updated }
}

/** True when the user has an ACTIVE driving session right now. Business optional
 *  (the feature is Lifestyle-scoped, so a userId match alone is sufficient). */
export async function isStaffDriving(userId: string, businessId?: string): Promise<boolean> {
  const row = await prisma.drivingModeSession.findFirst({
    where: { userId, status: 'ACTIVE', ...(businessId ? { businessId } : {}) },
    select: { id: true },
  })
  return Boolean(row)
}

/** Set of AgentStaff ids with an ACTIVE driving session — for the task-proposal gate. */
export async function getActiveDrivingStaffIds(businessId: string): Promise<Set<string>> {
  const rows = await prisma.drivingModeSession.findMany({
    where: { businessId, status: 'ACTIVE', staffId: { not: null } },
    select: { staffId: true },
  })
  return new Set(rows.map((r) => r.staffId as string))
}

/** Names of staff currently driving — for agent context / display. */
export async function getActiveDrivingStaff(
  businessId: string,
): Promise<Array<{ userId: string; staffId: string | null; name: string; startedAt: Date }>> {
  const rows = await prisma.drivingModeSession.findMany({
    where: { businessId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    include: { user: { select: { name: true } } },
  })
  return rows.map((r) => ({
    userId: r.userId,
    staffId: r.staffId,
    name: r.user?.name || r.employeeId,
    startedAt: r.startedAt,
  }))
}
