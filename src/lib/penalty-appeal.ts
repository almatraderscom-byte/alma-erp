import type { AttendanceWaiverRequest, AttendanceWaiverRequestType, AttendanceWaiverStatus } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { reverseAttendancePenalty } from '@/lib/attendance'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import { createApprovalRequest, dispatchApprovalsUpdated, resolveApprovalRequest } from '@/lib/approvals'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { enqueueTelegramNotificationAndFlush } from '@/lib/telegram-notification/queue'
import { attendanceDeepLink, escapeHtml } from '@/lib/telegram-notification/formatters'
import { logTelegramOpsAudit } from '@/lib/telegram-ops-audit'
import { logEvent } from '@/lib/logger'
import type { AlmaRole } from '@/lib/roles'
import { penaltyAppealTelegramKeyboard, formatPenaltyAppealTelegramMessage } from '@/lib/penalty-appeal-telegram'

export const PENALTY_REVIEW_ROLES: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN']
export const PENALTY_APPEAL_MODULE = 'PAYROLL' as const
export const PENALTY_APPEAL_TYPE = APPROVAL_TYPES.PENALTY_APPEAL
export const MAX_APPEAL_ATTACHMENT_BYTES = 600_000

export function canReviewPenaltyAppeals(role: string): boolean {
  return PENALTY_REVIEW_ROLES.includes(role as AlmaRole)
}

export function displayWaiverStatus(status: AttendanceWaiverStatus): string {
  if (status === 'APPROVED') return 'FULLY_APPROVED'
  return status
}

export function finalAppliedPenalty(
  original: number,
  status: AttendanceWaiverStatus,
  approvedReduction: number | null,
): number {
  const orig = Math.max(0, Number(original) || 0)
  if (status === 'APPROVED' || status === 'PARTIALLY_APPROVED') {
    const reduction = Math.min(orig, Math.max(0, Number(approvedReduction) || 0))
    return Math.max(0, orig - reduction)
  }
  if (status === 'CANCELLED' || status === 'REJECTED') return orig
  return orig
}

export function parseRequestType(raw: unknown): AttendanceWaiverRequestType {
  const v = String(raw || 'FULL_WAIVE').toUpperCase()
  if (v === 'PARTIAL_REDUCE' || v === 'PARTIAL') return 'PARTIAL_REDUCE'
  if (v === 'RECONSIDERATION' || v === 'REVIEW') return 'RECONSIDERATION'
  return 'FULL_WAIVE'
}

export function defaultRequestedReduction(
  penalty: number,
  requestType: AttendanceWaiverRequestType,
  explicit?: number | null,
): number {
  if (explicit != null && Number.isFinite(explicit)) {
    return Math.min(penalty, Math.max(0, Number(explicit)))
  }
  if (requestType === 'PARTIAL_REDUCE') return Math.min(penalty, Math.max(0, Math.round(penalty * 0.5)))
  return penalty
}

export function penaltyAppealDto(waiver: AttendanceWaiverRequest) {
  const original = Number(waiver.originalPenaltyAmount || 0)
  const approved = waiver.approvedReductionAmount == null ? null : Number(waiver.approvedReductionAmount)
  return {
    id: waiver.id,
    attendanceRecordId: waiver.attendanceRecordId,
    businessId: waiver.businessId,
    userId: waiver.userId,
    employeeId: waiver.employeeId,
    status: waiver.status,
    statusLabel: displayWaiverStatus(waiver.status),
    requestType: waiver.requestType,
    originalPenaltyAmount: original,
    requestedReductionAmount: waiver.requestedReductionAmount == null ? null : Number(waiver.requestedReductionAmount),
    approvedReductionAmount: approved,
    finalAppliedPenalty: finalAppliedPenalty(original, waiver.status, approved),
    reason: waiver.reason,
    hasAttachment: Boolean(waiver.attachmentDataUrl),
    adminNote: waiver.adminNote,
    reviewedById: waiver.reviewedById,
    reviewedAt: waiver.reviewedAt?.toISOString() || null,
    reversalLedgerEntryId: waiver.reversalLedgerEntryId,
    createdAt: waiver.createdAt.toISOString(),
    updatedAt: waiver.updatedAt.toISOString(),
  }
}

export type ReviewPenaltyAppealInput = {
  waiverId: string
  businessId: string
  actorUserId: string | null
  action: 'APPROVE' | 'REJECT'
  approvedReductionAmount?: number
  adminNote?: string
  source?: 'erp' | 'telegram' | 'attendance' | 'api'
}

export async function createPenaltyAppealApproval(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
) {
  const requested = Number(waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount)
  const original = Number(waiver.originalPenaltyAmount)
  const employeeName = waiver.requester?.name || ctx.userName || ctx.employeeId

  return createApprovalRequest({
    module: PENALTY_APPEAL_MODULE,
    type: PENALTY_APPEAL_TYPE,
    businessId: waiver.businessId,
    entityId: waiver.id,
    requestedBy: ctx.userId,
    reason: waiver.reason,
    priority: 'HIGH',
    actionUrl: `/attendance?review=${waiver.id}`,
    title: 'Penalty reduction review required',
    message: `${employeeName} (${ctx.employeeId}) requested penalty review · ৳${requested.toLocaleString('en-BD')} of ৳${original.toLocaleString('en-BD')}.`,
    payloadSnapshot: {
      waiverId: waiver.id,
      attendanceRecordId: waiver.attendanceRecordId,
      employeeId: ctx.employeeId,
      employeeName,
      requestType: waiver.requestType,
      originalPenaltyAmount: original,
      requestedReductionAmount: requested,
    },
  })
}

async function rollbackPenaltyReview(waiverId: string) {
  await prisma.attendanceWaiverRequest.update({
    where: { id: waiverId },
    data: {
      status: 'PENDING',
      approvedReductionAmount: null,
      adminNote: null,
      reviewedById: null,
      reviewedAt: null,
    },
  })
  const approval = await prisma.approvalRequest.findFirst({
    where: { module: PENALTY_APPEAL_MODULE, type: PENALTY_APPEAL_TYPE, entityId: waiverId },
    orderBy: { createdAt: 'desc' },
  })
  if (approval && approval.status !== 'PENDING') {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'PENDING', approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null },
    })
  }
}

export async function reviewPenaltyAppeal(input: ReviewPenaltyAppealInput) {
  const waiver = await prisma.attendanceWaiverRequest.findFirst({
    where: { id: input.waiverId, businessId: input.businessId },
    include: { requester: { select: { name: true } } },
  })
  if (!waiver) return { error: 'Appeal request not found.', status: 404 as const }
  if (waiver.status !== 'PENDING') {
    const dto = penaltyAppealDto(waiver)
    return { ok: true as const, waiver: dto, alreadyReviewed: true as const }
  }

  const actorUserId = input.actorUserId
  if (!actorUserId) {
    return { error: 'Reviewer identity is required for audit trail.', status: 403 as const }
  }

  const originalPenalty = Number(waiver.originalPenaltyAmount || 0)
  const action = input.action === 'REJECT' ? 'REJECT' : 'APPROVE'
  const requestedReduction = Number(waiver.requestedReductionAmount ?? originalPenalty)
  const approvedReduction = action === 'APPROVE'
    ? Math.min(originalPenalty, Math.max(0, Number(input.approvedReductionAmount ?? requestedReduction)))
    : 0

  if (action === 'APPROVE' && approvedReduction <= 0) {
    return { error: 'Approved reduction must be greater than zero.', status: 400 as const }
  }

  const waiverStatus =
    action === 'REJECT'
      ? 'REJECTED'
      : approvedReduction >= originalPenalty
        ? 'APPROVED'
        : 'PARTIALLY_APPROVED'

  const approvalStatus = action === 'REJECT' ? 'REJECTED' : 'APPROVED'
  const source = input.source || 'erp'
  const adminNote = String(input.adminNote || '').trim().slice(0, 1200) || null

  let reviewed: AttendanceWaiverRequest
  let approvalId: string | null = null

  try {
    const txResult = await prisma.$transaction(async tx => {
      const locked = await tx.attendanceWaiverRequest.findFirst({
        where: { id: waiver.id, businessId: input.businessId, status: 'PENDING' },
      })
      if (!locked) throw new Error('ALREADY_REVIEWED')

      let approval = await tx.approvalRequest.findFirst({
        where: {
          module: PENALTY_APPEAL_MODULE,
          type: PENALTY_APPEAL_TYPE,
          entityId: waiver.id,
          status: 'PENDING',
        },
      })

      if (!approval) {
        const requested = Number(locked.requestedReductionAmount ?? locked.originalPenaltyAmount)
        const original = Number(locked.originalPenaltyAmount)
        approval = await tx.approvalRequest.create({
          data: {
            module: PENALTY_APPEAL_MODULE,
            type: PENALTY_APPEAL_TYPE,
            businessId: locked.businessId,
            entityId: locked.id,
            requestedBy: locked.userId,
            reason: locked.reason,
            priority: 'HIGH',
            actionUrl: `/attendance?review=${locked.id}`,
            auditHistory: [
              {
                action: 'REQUESTED',
                actorUserId: locked.userId,
                reason: locked.reason,
                source: 'erp',
                timestamp: locked.createdAt.toISOString(),
              },
              {
                action: 'BACKFILLED',
                actorUserId,
                reason: 'Approval record created during review (legacy request)',
                source,
                timestamp: new Date().toISOString(),
              },
            ] as Prisma.InputJsonValue,
            payloadSnapshot: {
              waiverId: locked.id,
              attendanceRecordId: locked.attendanceRecordId,
              employeeId: locked.employeeId,
              originalPenaltyAmount: original,
              requestedReductionAmount: requested,
            } as Prisma.InputJsonObject,
          },
        })
      }

      const row = await tx.attendanceWaiverRequest.update({
        where: { id: waiver.id },
        data: {
          status: waiverStatus,
          approvedReductionAmount: action === 'APPROVE' ? new Prisma.Decimal(approvedReduction.toFixed(2)) : null,
          adminNote,
          reviewedById: actorUserId,
          reviewedAt: new Date(),
        },
      })

      if (approval) {
        await resolveApprovalRequest({
          module: PENALTY_APPEAL_MODULE,
          type: PENALTY_APPEAL_TYPE,
          entityId: waiver.id,
          status: approvalStatus,
          actorUserId,
          reason: adminNote || `Reviewed via ${source}`,
          source,
          tx,
        })
      }

      return { row, approvalId: approval?.id || null }
    })
    reviewed = txResult.row
    approvalId = txResult.approvalId
  } catch (e) {
    if ((e as Error).message === 'ALREADY_REVIEWED') {
      const fresh = await prisma.attendanceWaiverRequest.findUniqueOrThrow({ where: { id: waiver.id } })
      return { ok: true as const, waiver: penaltyAppealDto(fresh), alreadyReviewed: true as const }
    }
    throw e
  }

  if (action === 'APPROVE') {
    try {
      await reverseAttendancePenalty(reviewed, actorUserId)
      reviewed = await prisma.attendanceWaiverRequest.findUniqueOrThrow({ where: { id: reviewed.id } })
    } catch (walletErr) {
      await rollbackPenaltyReview(waiver.id)
      logEvent('error', 'penalty_appeal.wallet_failed', {
        waiverId: waiver.id,
        error: (walletErr as Error).message,
      })
      return {
        error: 'Approval was recorded but wallet adjustment failed. Request restored to pending — retry from ERP.',
        status: 500 as const,
      }
    }
  }

  const dto = penaltyAppealDto(reviewed)

  await notifyUser({
    userId: waiver.userId,
    businessId: waiver.businessId,
    type: 'PAYROLL_ALERT',
    priority: 'HIGH',
    title: action === 'APPROVE' ? 'Penalty appeal approved' : 'Penalty appeal rejected',
    message: action === 'APPROVE'
      ? `৳ ${approvedReduction.toLocaleString('en-BD')} was credited back. Final penalty: ৳ ${dto.finalAppliedPenalty.toLocaleString('en-BD')}.`
      : 'Your penalty review request was rejected. The original penalty remains on your wallet.',
    actionUrl: '/portal',
  })

  enqueueTelegramNotificationAndFlush({
    businessId: waiver.businessId,
    eventType: 'ATTENDANCE_WAIVER_REVIEWED',
    message: [
      action === 'APPROVE' ? '✅ <b>Penalty Appeal Approved</b>' : '❌ <b>Penalty Appeal Rejected</b>',
      '',
      `<b>Employee:</b> ${escapeHtml(waiver.requester.name)} (${escapeHtml(waiver.employeeId)})`,
      action === 'APPROVE'
        ? `<b>Reduction:</b> ৳ ${approvedReduction.toLocaleString('en-BD')} · <b>Final penalty:</b> ৳ ${dto.finalAppliedPenalty.toLocaleString('en-BD')}`
        : `<b>Status:</b> Rejected — original penalty kept`,
      '',
      `<a href="${attendanceDeepLink(waiver.businessId, waiver.employeeId)}">Attendance →</a>`,
    ].join('\n'),
    dedupeKey: `waiver:review:${waiver.id}:${action}`,
    metadata: withEmployeeAvatarMetadata(
      { employeeId: waiver.employeeId, attendanceRecordId: waiver.attendanceRecordId, waiverId: waiver.id },
      waiver.userId,
      undefined,
    ),
  })

  await logTelegramOpsAudit({
    businessId: waiver.businessId,
    eventType: action === 'APPROVE' ? 'WAIVER_APPROVED' : 'WAIVER_REJECTED',
    actorUserId,
    employeeId: waiver.employeeId,
    attendanceRecordId: waiver.attendanceRecordId,
    detail: String(input.adminNote || '').slice(0, 500) || undefined,
    metadata: { approvedReduction, action, finalAppliedPenalty: dto.finalAppliedPenalty, approvalId, source },
  })

  dispatchApprovalsUpdated()

  return { ok: true as const, waiver: dto, approvalId }
}

export async function notifyPenaltyAppealSubmitted(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
) {
  const requested = Number(waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount)
  const original = Number(waiver.originalPenaltyAmount)
  const employeeName = waiver.requester?.name || ctx.userName || ctx.employeeId

  await Promise.all(
    PENALTY_REVIEW_ROLES.map(role =>
      notifyRole({
        role,
        businessId: waiver.businessId,
        type: 'PAYROLL_ALERT',
        priority: 'HIGH',
        title: 'Penalty review request',
        message: `${employeeName} (${ctx.employeeId}) requested review of ৳ ${requested.toLocaleString('en-BD')} late penalty.`,
        actionUrl: `/attendance?review=${waiver.id}`,
      }),
    ),
  )

  const appBase = process.env.NEXTAUTH_URL?.replace(/\/$/, '')
    || (process.env.VERCEL_URL ? `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//, '')}` : '')
    || 'https://alma-erp-six.vercel.app'
  const erpUrl = `${appBase.replace(/\/$/, '')}/attendance?review=${waiver.id}`

  enqueueTelegramNotificationAndFlush({
    businessId: waiver.businessId,
    eventType: 'ATTENDANCE_WAIVER_SUBMITTED',
    message: formatPenaltyAppealTelegramMessage({
      employeeName,
      employeeId: ctx.employeeId,
      penaltyAmount: original,
      requestedReduction: requested,
      requestType: waiver.requestType,
      reason: waiver.reason,
    }),
    dedupeKey: `waiver:submit:${waiver.id}`,
    metadata: withEmployeeAvatarMetadata(
      {
        employeeId: ctx.employeeId,
        attendanceRecordId: waiver.attendanceRecordId,
        waiverId: waiver.id,
        deliveryMode: 'text',
        replyMarkup: penaltyAppealTelegramKeyboard(waiver.id, erpUrl),
      },
      ctx.userId,
      undefined,
    ),
  })

  await logTelegramOpsAudit({
    businessId: waiver.businessId,
    eventType: 'WAIVER_SUBMITTED',
    actorUserId: ctx.userId,
    employeeId: ctx.employeeId,
    attendanceRecordId: waiver.attendanceRecordId,
    detail: waiver.reason.slice(0, 500),
    metadata: { requestType: waiver.requestType, requestedReduction: requested },
  })
}

export function validateAttachmentDataUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(raw || '').trim()
  if (!s) return { ok: true, value: '' }
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/i.exec(s)
  if (!match) return { ok: false, error: 'Attachment must be a JPG, PNG, or WEBP image.' }
  const bytes = Buffer.byteLength(match[2], 'base64')
  if (bytes > MAX_APPEAL_ATTACHMENT_BYTES) {
    return { ok: false, error: 'Attachment is too large (max ~600 KB).' }
  }
  return { ok: true, value: s.slice(0, 900_000) }
}

export async function getPenaltyAppealAnalytics(businessId: string, monthStart: Date, monthEnd: Date) {
  const [penaltyAgg, waivers, repeatRows] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where: {
        businessId,
        attendanceDate: { gte: monthStart, lt: monthEnd },
        penaltyAmount: { gt: 0 },
      },
      _sum: { penaltyAmount: true },
      _count: { id: true },
    }),
    prisma.attendanceWaiverRequest.findMany({
      where: { businessId, createdAt: { gte: monthStart, lt: monthEnd } },
      select: {
        status: true,
        originalPenaltyAmount: true,
        approvedReductionAmount: true,
        employeeId: true,
        requestType: true,
      },
    }),
    prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        businessId,
        attendanceDate: { gte: monthStart, lt: monthEnd },
        penaltyAmount: { gt: 0 },
      },
      _sum: { penaltyAmount: true },
      _count: { id: true },
      orderBy: { _sum: { penaltyAmount: 'desc' } },
      take: 8,
    }),
  ])

  const totalPenalties = Number(penaltyAgg._sum.penaltyAmount || 0)
  const penaltyIncidentCount = penaltyAgg._count.id

  let waivedAmount = 0
  let reducedAmount = 0
  let pendingCount = 0
  let approvedCount = 0
  let rejectedCount = 0
  let cancelledCount = 0

  for (const w of waivers) {
    if (w.status === 'PENDING') pendingCount += 1
    if (w.status === 'REJECTED') rejectedCount += 1
    if (w.status === 'CANCELLED') cancelledCount += 1
    if (w.status === 'APPROVED' || w.status === 'PARTIALLY_APPROVED') {
      approvedCount += 1
      const red = Number(w.approvedReductionAmount || 0)
      waivedAmount += red
      if (w.status === 'PARTIALLY_APPROVED') reducedAmount += red
    }
  }

  const repeatOffenders = repeatRows.map(r => ({
    employeeId: r.employeeId,
    penaltyCount: r._count.id,
    penaltyTotal: Number(r._sum.penaltyAmount || 0),
  }))

  return {
    totalPenalties,
    penaltyIncidentCount,
    waivedAmount,
    reducedAmount,
    netPenaltiesAfterWaivers: Math.max(0, totalPenalties - waivedAmount),
    appealCount: waivers.length,
    pendingCount,
    approvedCount,
    rejectedCount,
    cancelledCount,
    approvalRate: waivers.length ? Math.round((approvedCount / waivers.length) * 100) : 0,
    repeatOffenders,
    byRequestType: {
      fullWaive: waivers.filter(w => w.requestType === 'FULL_WAIVE').length,
      partialReduce: waivers.filter(w => w.requestType === 'PARTIAL_REDUCE').length,
      reconsideration: waivers.filter(w => w.requestType === 'RECONSIDERATION').length,
    },
  }
}
