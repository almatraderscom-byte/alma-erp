import type { AttendanceWaiverRequest, AttendanceWaiverRequestType, AttendanceWaiverStatus } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  attendanceReversalSourceRef,
  LATE_PENALTY_REVERSAL_SOURCE,
  penaltyRefundNoteBn,
} from '@/lib/attendance'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  notifyApprovalResolved,
  notifyApprovalSuperAdmins,
  resolveApprovalRequest,
} from '@/lib/approvals'
import { moneyDecimal } from '@/lib/payroll-wallet'
import {
  deferAfterApprovalCommit,
  FAST_TX_OPTIONS,
  runApprovalTransaction,
  type ApprovalTx,
} from '@/lib/prisma-transaction'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { scheduleTelegramNotification } from '@/lib/telegram-notification/queue'
import { attendanceDeepLink, escapeHtml } from '@/lib/telegram-notification/formatters'
import { logTelegramOpsAudit } from '@/lib/telegram-ops-audit'
import { logEvent } from '@/lib/logger'
import type { AlmaRole } from '@/lib/roles'
import { penaltyAppealTelegramKeyboard, formatPenaltyAppealTelegramMessage } from '@/lib/penalty-appeal-telegram'
import {
  normalizePenaltyReviewNote,
  PENALTY_REJECTION_REASON_MIN_LENGTH,
  resolveApprovedPenaltyReduction,
} from '@/lib/penalty-appeal-policy'
import { attendancePenaltyKindLabel, resolveAttendancePenaltyTarget } from '@/lib/attendance-penalty-target'
import { enqueuePenaltyAppealReviewedSms } from '@/services/sms/events'

export const PENALTY_REVIEW_ROLES: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN']
export const PENALTY_APPEAL_MODULE = 'PAYROLL' as const
export const PENALTY_APPEAL_TYPE = APPROVAL_TYPES.PENALTY_APPEAL
export const MAX_APPEAL_ATTACHMENT_BYTES = 600_000
/** Owner rule (2026-07-11): staff may appeal a fine within 30 days of the fine date. */
export const APPEAL_WINDOW_DAYS = 30

function penaltySourceLabel(source: string | null | undefined): string {
  if (source === 'attendance_early_leave_penalty') return 'Early check-out penalty'
  if (source === 'attendance_no_checkout_fine') return 'No check-out penalty'
  if (source === 'attendance_late_penalty') return 'Late check-in penalty'
  return 'Attendance penalty'
}

export function appealDeadline(fineDate: Date): Date {
  return new Date(fineDate.getTime() + APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000)
}

export function isWithinAppealWindow(fineDate: Date, now = new Date()): boolean {
  return now.getTime() <= appealDeadline(fineDate).getTime()
}

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
    penaltyLedgerEntryId: waiver.penaltyLedgerEntryId,
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

export function penaltyAppealApprovalPayload(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
) {
  const requested = Number(waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount)
  const original = Number(waiver.originalPenaltyAmount)
  const employeeName = waiver.requester?.name || ctx.userName || ctx.employeeId
  return {
    requested,
    original,
    employeeName,
    snapshot: {
      waiverId: waiver.id,
      attendanceRecordId: waiver.attendanceRecordId,
      penaltyLedgerEntryId: waiver.penaltyLedgerEntryId,
      employeeId: ctx.employeeId,
      employeeName,
      requestType: waiver.requestType,
      originalPenaltyAmount: original,
      requestedReductionAmount: requested,
    },
  }
}

export async function createPenaltyAppealApproval(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
  options?: { tx?: ApprovalTx; skipNotify?: boolean },
) {
  const { requested, original, employeeName, snapshot } = penaltyAppealApprovalPayload(waiver, ctx)

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
    payloadSnapshot: snapshot,
    tx: options?.tx,
    skipNotify: options?.skipNotify,
  })
}

/** Ensures a pending central approval exists for a pending waiver (repairs orphan waivers). */
async function notifyCentralApprovalQueue(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
  approvalId: string,
) {
  const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
  if (!approval || approval.status !== 'PENDING') return
  const { requested, original, employeeName } = penaltyAppealApprovalPayload(waiver, ctx)
  await notifyApprovalSuperAdmins(approval, {
    title: 'Penalty reduction review required',
    message: `${employeeName} (${ctx.employeeId}) requested penalty review · ৳${requested.toLocaleString('en-BD')} of ৳${original.toLocaleString('en-BD')}.`,
  })
}

export async function ensurePenaltyAppealApproval(
  waiver: AttendanceWaiverRequest & { requester?: { name: string } | null },
  ctx: { employeeId: string; userId: string; userName?: string },
) {
  if (waiver.status !== 'PENDING') {
    return { ok: false as const, error: `Waiver is ${waiver.status}, not pending.` }
  }
  const approval = await createPenaltyAppealApproval(waiver, ctx)
  await notifyCentralApprovalQueue(waiver, ctx, approval.id)
  logEvent('info', 'penalty_appeal.approval.repaired', { waiverId: waiver.id, approvalId: approval.id })
  return { ok: true as const, approval }
}

export async function findPenaltyAppealByLedgerEntry(penaltyLedgerEntryId: string, userId: string) {
  return prisma.attendanceWaiverRequest.findFirst({
    where: { penaltyLedgerEntryId, userId },
    include: { requester: { select: { name: true } } },
  })
}

export type SubmitPenaltyAppealInput = {
  attendanceRecordId: string
  businessId: string
  userId: string
  employeeId: string
  userName?: string
  reason: string
  requestType: AttendanceWaiverRequestType
  requestedReduction: number
  originalPenalty: number
  penaltyLedgerEntryId: string
  attachmentDataUrl: string | null
}

export type SubmitPenaltyAppealResult =
  | { ok: true; waiver: ReturnType<typeof penaltyAppealDto>; created: true }
  | { error: string; status: number }

/** Atomic, once-only appeal submit for one exact wallet penalty row. */
export async function submitPenaltyAppeal(input: SubmitPenaltyAppealInput): Promise<SubmitPenaltyAppealResult> {
  const ctx = { employeeId: input.employeeId, userId: input.userId, userName: input.userName }

  const attendanceRecord = await prisma.attendanceRecord.findUnique({
    where: { id: input.attendanceRecordId },
    select: {
      attendanceDate: true,
      penaltyAmount: true,
      penaltyLedgerEntryId: true,
      earlyLeavePenaltyAmount: true,
      earlyLeavePenaltyLedgerEntryId: true,
      noCheckoutFineAmount: true,
      noCheckoutFineLedgerEntryId: true,
    },
  })
  if (attendanceRecord && !isWithinAppealWindow(attendanceRecord.attendanceDate)) {
    return {
      error: `আপিলের সময়সীমা শেষ — জরিমানার দিন থেকে ${APPEAL_WINDOW_DAYS} দিনের মধ্যে আপিল করা যায়।`,
      status: 400,
    }
  }
  const existing = await findPenaltyAppealByLedgerEntry(input.penaltyLedgerEntryId, input.userId)
  const legacyRows = existing || !attendanceRecord ? [] : await prisma.attendanceWaiverRequest.findMany({
    where: {
      attendanceRecordId: input.attendanceRecordId,
      userId: input.userId,
      penaltyLedgerEntryId: null,
    },
    select: { originalPenaltyAmount: true },
  })
  const legacyExisting = attendanceRecord
    ? legacyRows.some(row => (
        resolveAttendancePenaltyTarget(attendanceRecord, null, row.originalPenaltyAmount)?.ledgerEntryId
          === input.penaltyLedgerEntryId
      ))
    : false

  if (existing || legacyExisting) {
    return {
      error: 'এই নির্দিষ্ট জরিমানার জন্য ইতোমধ্যে একবার আপিল করা হয়েছে। একই জরিমানায় আবার আপিল করা যাবে না।',
      status: 409,
    }
  }

  try {
    const waiver = await runApprovalTransaction('penalty_appeal.submit', async tx => {
      const row = await tx.attendanceWaiverRequest.create({
        data: {
          attendanceRecordId: input.attendanceRecordId,
          businessId: input.businessId,
          userId: input.userId,
          employeeId: input.employeeId,
          requestType: input.requestType,
          originalPenaltyAmount: new Prisma.Decimal(input.originalPenalty.toFixed(2)),
          requestedReductionAmount: new Prisma.Decimal(input.requestedReduction.toFixed(2)),
          reason: input.reason.slice(0, 1200),
          attachmentDataUrl: input.attachmentDataUrl,
          penaltyLedgerEntryId: input.penaltyLedgerEntryId,
        },
        include: { requester: { select: { name: true } } },
      })
      await createPenaltyAppealApproval(row, ctx, { tx, skipNotify: true })
      return row
    }, FAST_TX_OPTIONS)

    const approval = await prisma.approvalRequest.findFirst({
      where: {
        module: PENALTY_APPEAL_MODULE,
        type: PENALTY_APPEAL_TYPE,
        entityId: waiver.id,
        status: 'PENDING',
      },
    })
    if (approval) await notifyCentralApprovalQueue(waiver, ctx, approval.id)
    try {
      await notifyPenaltyAppealSubmitted(waiver, ctx)
    } catch (notifyErr) {
      logEvent('warn', 'penalty_appeal.notify_failed', { waiverId: waiver.id, error: (notifyErr as Error).message })
    }
    dispatchApprovalsUpdated()
    return { ok: true, waiver: penaltyAppealDto(waiver), created: true }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return {
        error: 'এই নির্দিষ্ট জরিমানার জন্য ইতোমধ্যে একবার আপিল করা হয়েছে। একই জরিমানায় আবার আপিল করা যাবে না।',
        status: 409,
      }
    }
    throw e
  }
}

async function applyPenaltyReversalInTx(
  tx: ApprovalTx,
  waiver: Pick<AttendanceWaiverRequest, 'id' | 'businessId' | 'employeeId' | 'userId' | 'reversalLedgerEntryId'> & { penaltyLedgerEntryId?: string | null },
  approvedReduction: number,
  actorUserId: string,
) {
  if (waiver.reversalLedgerEntryId) return null
  const amount = Number(approvedReduction || 0)
  if (!Number.isFinite(amount) || amount <= 0) return null

  const fineEntry = waiver.penaltyLedgerEntryId
    ? await tx.employeeLedgerEntry.findFirst({
        where: {
          id: waiver.penaltyLedgerEntryId,
          employeeId: waiver.employeeId,
          businessId: waiver.businessId,
          type: 'PENALTY',
          isArchived: false,
        },
        select: { id: true, date: true },
      })
    : null
  if (!fineEntry) throw new Error('PENALTY_LEDGER_LINK_INVALID')

  const sourceRef = attendanceReversalSourceRef(waiver.id)
  try {
    const entry = await tx.employeeLedgerEntry.create({
      data: {
        employeeId: waiver.employeeId,
        businessId: waiver.businessId,
        date: new Date(),
        type: 'ADJUSTMENT',
        amount: moneyDecimal(amount),
        note: penaltyRefundNoteBn(fineEntry?.date),
        createdById: actorUserId,
        approvedById: actorUserId,
        source: LATE_PENALTY_REVERSAL_SOURCE,
        sourceRef,
        relatedEntryId: fineEntry?.id || waiver.penaltyLedgerEntryId || null,
      },
    })
    await tx.attendanceWaiverRequest.update({
      where: { id: waiver.id },
      data: { reversalLedgerEntryId: entry.id },
    })
    return entry
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await tx.employeeLedgerEntry.findUnique({
        where: { source_sourceRef: { source: LATE_PENALTY_REVERSAL_SOURCE, sourceRef } },
      })
      if (existing) {
        await tx.attendanceWaiverRequest.update({
          where: { id: waiver.id },
          data: { reversalLedgerEntryId: existing.id },
        })
        return existing
      }
    }
    throw e
  }
}

export async function reviewPenaltyAppeal(input: ReviewPenaltyAppealInput) {
  const waiver = await prisma.attendanceWaiverRequest.findFirst({
    where: { id: input.waiverId, businessId: input.businessId },
    include: { requester: { select: { name: true, phone: true } } },
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

  const action = input.action === 'REJECT' ? 'REJECT' : 'APPROVE'
  let penaltyLedgerEntryId = waiver.penaltyLedgerEntryId
  if (action === 'APPROVE' && !penaltyLedgerEntryId) {
    const record = await prisma.attendanceRecord.findUnique({
      where: { id: waiver.attendanceRecordId },
      select: {
        penaltyLedgerEntryId: true,
        earlyLeavePenaltyLedgerEntryId: true,
        noCheckoutFineLedgerEntryId: true,
      },
    })
    const candidateIds = Array.from(new Set([
      record?.penaltyLedgerEntryId,
      record?.earlyLeavePenaltyLedgerEntryId,
      record?.noCheckoutFineLedgerEntryId,
    ].filter((id): id is string => Boolean(id))))
    const candidates = candidateIds.length
      ? await prisma.employeeLedgerEntry.findMany({
          where: {
            id: { in: candidateIds },
            employeeId: waiver.employeeId,
            businessId: waiver.businessId,
            type: 'PENALTY',
            isArchived: false,
          },
          select: { id: true, amount: true },
        })
      : []
    const snapshotAmount = Math.abs(Number(waiver.originalPenaltyAmount || 0))
    const amountMatches = candidates.filter(row => Math.abs(Math.abs(Number(row.amount || 0)) - snapshotAmount) < 0.01)
    penaltyLedgerEntryId = (amountMatches.length === 1 ? amountMatches[0] : candidates.length === 1 ? candidates[0] : null)?.id || null
  }

  const penaltyEntry = penaltyLedgerEntryId
    ? await prisma.employeeLedgerEntry.findFirst({
        where: {
          id: penaltyLedgerEntryId,
          employeeId: waiver.employeeId,
          businessId: waiver.businessId,
          type: 'PENALTY',
          isArchived: false,
        },
        select: { id: true, amount: true, source: true, date: true },
      })
    : null
  if (action === 'APPROVE' && !penaltyEntry) {
    return {
      error: 'Exact wallet penalty row could not be verified. Reject with an explanation or repair the ledger link before approval.',
      status: 409 as const,
    }
  }

  const originalPenalty = penaltyEntry
    ? Math.abs(Number(penaltyEntry.amount || 0))
    : Math.abs(Number(waiver.originalPenaltyAmount || 0))
  const requestedReduction = Math.min(
    originalPenalty,
    Math.abs(Number(waiver.requestedReductionAmount ?? originalPenalty)),
  )
  const reductionDecision = action === 'APPROVE'
    ? resolveApprovedPenaltyReduction(originalPenalty, requestedReduction, input.approvedReductionAmount)
    : null
  if (reductionDecision && !reductionDecision.ok) {
    const messages = {
      INVALID_AMOUNT: 'Approved wallet credit must be a valid amount.',
      AMOUNT_REQUIRED: 'Approved wallet credit must be greater than zero.',
      EXCEEDS_REQUESTED_AMOUNT: `Approved wallet credit cannot exceed the staff request of ৳ ${requestedReduction.toLocaleString('en-BD')}.`,
      EXCEEDS_ORIGINAL_PENALTY: `Approved wallet credit cannot exceed the original penalty of ৳ ${originalPenalty.toLocaleString('en-BD')}.`,
    }
    return { error: messages[reductionDecision.reason], status: 400 as const }
  }
  const approvedReduction = reductionDecision?.amount ?? 0

  const waiverStatus =
    action === 'REJECT'
      ? 'REJECTED'
      : approvedReduction >= originalPenalty
        ? 'APPROVED'
        : 'PARTIALLY_APPROVED'

  const approvalStatus = action === 'REJECT' ? 'REJECTED' : 'APPROVED'
  const source = input.source || 'erp'
  const reviewNote = normalizePenaltyReviewNote(action, input.adminNote)
  if (!reviewNote.ok) {
    return {
      error: `Reject করার আগে স্পষ্ট কারণ লিখুন (অন্তত ${PENALTY_REJECTION_REASON_MIN_LENGTH} অক্ষর)।`,
      status: 400 as const,
    }
  }
  const adminNote = reviewNote.note

  let reviewed: AttendanceWaiverRequest
  let approvalId: string | null = null

  try {
    const txResult = await runApprovalTransaction('penalty_appeal.review', async tx => {
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
              penaltyLedgerEntryId,
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
          penaltyLedgerEntryId,
          originalPenaltyAmount: new Prisma.Decimal(originalPenalty.toFixed(2)),
          requestedReductionAmount: new Prisma.Decimal(requestedReduction.toFixed(2)),
          approvedReductionAmount: action === 'APPROVE' ? new Prisma.Decimal(approvedReduction.toFixed(2)) : null,
          adminNote,
          reviewedById: actorUserId,
          reviewedAt: new Date(),
        },
      })

      if (action === 'APPROVE') {
        await applyPenaltyReversalInTx(
          tx,
          { ...locked, penaltyLedgerEntryId },
          approvedReduction,
          actorUserId,
        )
      }

      if (approval) {
        await resolveApprovalRequest({
          module: PENALTY_APPEAL_MODULE,
          type: PENALTY_APPEAL_TYPE,
          entityId: waiver.id,
          status: approvalStatus,
          actorUserId,
          reason: adminNote || `Approved via ${source}`,
          source,
          tx,
        })
      }

      return { row, approvalId: approval?.id || null }
    })
    reviewed = txResult.row
    approvalId = txResult.approvalId
  } catch (e) {
    const message = (e as Error).message || ''
    if (message === 'ALREADY_REVIEWED') {
      const fresh = await prisma.attendanceWaiverRequest.findUniqueOrThrow({ where: { id: waiver.id } })
      return { ok: true as const, waiver: penaltyAppealDto(fresh), alreadyReviewed: true as const }
    }
    if (message === 'PENALTY_LEDGER_LINK_INVALID') {
      return {
        error: 'Exact wallet penalty row could not be verified. Refresh the review and try again.',
        status: 409 as const,
      }
    }
    if (message.includes('Unable to start a transaction')) {
      return {
        error: 'Database is busy — please wait a moment and try again.',
        status: 503 as const,
      }
    }
    throw e
  }

  reviewed = await prisma.attendanceWaiverRequest.findUniqueOrThrow({ where: { id: reviewed.id } })
  const dto = penaltyAppealDto(reviewed)
  const reviewedFineLabel = penaltySourceLabel(penaltyEntry?.source)
  const reviewedFineDate = penaltyEntry?.date.toISOString().slice(0, 10)
  const isPartialApproval = action === 'APPROVE' && waiverStatus === 'PARTIALLY_APPROVED'
  const approvalOutcomeTitle = isPartialApproval
    ? 'Penalty appeal partially approved'
    : 'Penalty appeal fully approved'
  const fineIdentity = `${reviewedFineLabel}${reviewedFineDate ? ` · ${reviewedFineDate}` : ''}`

  deferAfterApprovalCommit('penalty_appeal.notify_requester', async () => {
    await notifyUser({
      userId: waiver.userId,
      businessId: waiver.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: action === 'APPROVE' ? approvalOutcomeTitle : 'Penalty appeal rejected',
      message: action === 'APPROVE'
        ? `${fineIdentity}: ${isPartialApproval ? 'partially approved' : 'fully approved'}. You requested ৳ ${requestedReduction.toLocaleString('en-BD')}; ৳ ${approvedReduction.toLocaleString('en-BD')} was credited to your wallet. Remaining penalty: ৳ ${dto.finalAppliedPenalty.toLocaleString('en-BD')}.${adminNote ? ` Note: ${adminNote}.` : ''}`
        : `${fineIdentity}: review rejected. Reason: ${adminNote}. The original penalty of ৳ ${originalPenalty.toLocaleString('en-BD')} remains on your wallet.`,
      actionUrl: penaltyLedgerEntryId
        ? `/portal/wallet#ledger-${penaltyLedgerEntryId}`
        : '/portal/wallet',
    })
    if (approvalId) {
      const approvalRow = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
      if (approvalRow) {
        await notifyApprovalResolved(approvalRow, actorUserId, approvalStatus, adminNote || undefined)
      }
    }
  })

  deferAfterApprovalCommit('penalty_appeal.sms_requester', async () => {
    enqueuePenaltyAppealReviewedSms({
      businessId: waiver.businessId,
      phone: waiver.requester.phone,
      employeeId: waiver.employeeId,
      waiverId: waiver.id,
      penaltyLedgerEntryId,
      action,
      partial: isPartialApproval,
      originalPenalty,
      requestedReduction,
      approvedReduction,
      remainingPenalty: dto.finalAppliedPenalty,
      fineLabel: reviewedFineLabel,
      fineDate: reviewedFineDate,
      reason: adminNote,
    })
  })

  await scheduleTelegramNotification({
    businessId: waiver.businessId,
    eventType: 'ATTENDANCE_WAIVER_REVIEWED',
    message: [
      action === 'APPROVE'
        ? isPartialApproval
          ? '✂️ <b>Penalty Appeal Partially Approved</b>'
          : '✅ <b>Penalty Appeal Fully Approved</b>'
        : '❌ <b>Penalty Appeal Rejected</b>',
      '',
      `<b>Employee:</b> ${escapeHtml(waiver.requester.name)} (${escapeHtml(waiver.employeeId)})`,
      `<b>Fine:</b> ${escapeHtml(reviewedFineLabel)}${reviewedFineDate ? ` · ${escapeHtml(reviewedFineDate)}` : ''}`,
      action === 'APPROVE'
        ? `<b>Requested:</b> ৳ ${requestedReduction.toLocaleString('en-BD')}\n<b>Wallet credit:</b> ৳ ${approvedReduction.toLocaleString('en-BD')} · <b>Remaining penalty:</b> ৳ ${dto.finalAppliedPenalty.toLocaleString('en-BD')}${adminNote ? `\n<b>Note:</b> ${escapeHtml(adminNote)}` : ''}`
        : `<b>Status:</b> Rejected — original penalty ৳ ${originalPenalty.toLocaleString('en-BD')} kept\n<b>Reason:</b> ${escapeHtml(adminNote || '')}`,
      '',
      `<a href="${attendanceDeepLink(waiver.businessId, waiver.employeeId)}">Attendance →</a>`,
    ].join('\n'),
    dedupeKey: `waiver:review:${waiver.id}:${action}`,
    metadata: withEmployeeAvatarMetadata(
      { employeeId: waiver.employeeId, attendanceRecordId: waiver.attendanceRecordId, waiverId: waiver.id, penaltyLedgerEntryId: penaltyLedgerEntryId || undefined },
      waiver.userId,
      undefined,
    ),
  })

  deferAfterApprovalCommit('penalty_appeal.telegram_audit', async () => {
    await logTelegramOpsAudit({
      businessId: waiver.businessId,
      eventType: action === 'APPROVE' ? 'WAIVER_APPROVED' : 'WAIVER_REJECTED',
      actorUserId,
      employeeId: waiver.employeeId,
      attendanceRecordId: waiver.attendanceRecordId,
      detail: String(input.adminNote || '').slice(0, 500) || undefined,
      metadata: { approvedReduction, action, finalAppliedPenalty: dto.finalAppliedPenalty, approvalId, source, penaltyLedgerEntryId, reviewedFineLabel, reviewedFineDate },
    })
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
  const record = await prisma.attendanceRecord.findUnique({
    where: { id: waiver.attendanceRecordId },
    select: {
      attendanceDate: true,
      penaltyAmount: true,
      penaltyLedgerEntryId: true,
      lateMinutes: true,
      earlyLeavePenaltyAmount: true,
      earlyLeavePenaltyLedgerEntryId: true,
      earlyLeaveMinutes: true,
      noCheckoutFineAmount: true,
      noCheckoutFineLedgerEntryId: true,
    },
  })
  const target = record
    ? resolveAttendancePenaltyTarget(record, waiver.penaltyLedgerEntryId, waiver.originalPenaltyAmount)
    : null
  const fineLabel = target ? attendancePenaltyKindLabel(target.kind) : 'Attendance penalty'
  const fineDate = record?.attendanceDate.toISOString().slice(0, 10)

  await Promise.all(
    PENALTY_REVIEW_ROLES.map(role =>
      notifyRole({
        role,
        businessId: waiver.businessId,
        type: 'PAYROLL_ALERT',
        priority: 'HIGH',
        title: 'Penalty review request',
        message: `${employeeName} (${ctx.employeeId}) requested review of ${fineLabel.toLowerCase()} · ${fineDate || 'date unavailable'} · ৳ ${requested.toLocaleString('en-BD')}.`,
        actionUrl: `/attendance?review=${waiver.id}`,
      }),
    ),
  )

  const appBase = process.env.NEXTAUTH_URL?.replace(/\/$/, '')
    || (process.env.VERCEL_URL ? `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//, '')}` : '')
    || 'https://alma-erp-six.vercel.app'
  const erpUrl = `${appBase.replace(/\/$/, '')}/attendance?review=${waiver.id}`

  await scheduleTelegramNotification({
    businessId: waiver.businessId,
    eventType: 'ATTENDANCE_WAIVER_SUBMITTED',
    message: formatPenaltyAppealTelegramMessage({
      employeeName,
      employeeId: ctx.employeeId,
      penaltyAmount: original,
      requestedReduction: requested,
      requestType: waiver.requestType,
      reason: waiver.reason,
      fineLabel,
      fineDate,
    }),
    dedupeKey: `waiver:submit:${waiver.id}`,
    metadata: withEmployeeAvatarMetadata(
      {
        employeeId: ctx.employeeId,
        attendanceRecordId: waiver.attendanceRecordId,
        waiverId: waiver.id,
        penaltyLedgerEntryId: waiver.penaltyLedgerEntryId || undefined,
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
    metadata: { requestType: waiver.requestType, requestedReduction: requested, penaltyLedgerEntryId: waiver.penaltyLedgerEntryId, fineLabel, fineDate },
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
  const penaltyRows = await prisma.employeeLedgerEntry.findMany({
    where: {
      businessId,
      isArchived: false,
      type: 'PENALTY',
      date: { gte: monthStart, lt: monthEnd },
      source: { in: [
        'attendance_late_penalty',
        'attendance_early_leave_penalty',
        'attendance_no_checkout_fine',
      ] },
    },
    select: { id: true, employeeId: true, amount: true },
  })
  const penaltyIds = penaltyRows.map(row => row.id)
  const waivers = await prisma.attendanceWaiverRequest.findMany({
    where: {
      businessId,
      OR: [
        ...(penaltyIds.length ? [{ penaltyLedgerEntryId: { in: penaltyIds } }] : []),
        { penaltyLedgerEntryId: null, createdAt: { gte: monthStart, lt: monthEnd } },
      ],
    },
    select: {
      status: true,
      originalPenaltyAmount: true,
      approvedReductionAmount: true,
      reversalLedgerEntryId: true,
      penaltyLedgerEntryId: true,
      employeeId: true,
      requestType: true,
    },
  })
  const refundIds = waivers.map(row => row.reversalLedgerEntryId).filter((id): id is string => Boolean(id))
  const refundRows = refundIds.length
    ? await prisma.employeeLedgerEntry.findMany({
        where: { id: { in: refundIds }, isArchived: false },
        select: { id: true, type: true, source: true, amount: true, relatedEntryId: true },
      })
    : []
  const refundMap = new Map(refundRows.map(row => [row.id, row]))

  const totalPenalties = penaltyRows.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0)
  const penaltyIncidentCount = penaltyRows.length
  const repeatByEmployee = new Map<string, { penaltyCount: number; penaltyTotal: number }>()
  for (const row of penaltyRows) {
    const current = repeatByEmployee.get(row.employeeId) || { penaltyCount: 0, penaltyTotal: 0 }
    current.penaltyCount += 1
    current.penaltyTotal += Math.abs(Number(row.amount || 0))
    repeatByEmployee.set(row.employeeId, current)
  }

  // Legacy null-linked appeals remain visible by submission month. Posted wallet
  // PENALTY rows are the amount source for all linked late/early/no-checkout fines.

  let waivedAmount = 0
  let reducedAmount = 0
  let pendingCount = 0
  let approvedCount = 0
  let rejectedCount = 0
  let cancelledCount = 0
  let reconciliationIssues = 0

  for (const w of waivers) {
    if (w.status === 'PENDING') pendingCount += 1
    if (w.status === 'REJECTED') rejectedCount += 1
    if (w.status === 'CANCELLED') cancelledCount += 1
    if (w.status === 'APPROVED' || w.status === 'PARTIALLY_APPROVED') {
      approvedCount += 1
      const expected = Number(w.approvedReductionAmount || 0)
      const refund = w.reversalLedgerEntryId ? refundMap.get(w.reversalLedgerEntryId) : null
      const linked = Boolean(
        refund
        && refund.type === 'ADJUSTMENT'
        && refund.source === LATE_PENALTY_REVERSAL_SOURCE
        && (!refund.relatedEntryId || refund.relatedEntryId === w.penaltyLedgerEntryId)
      )
      const red = linked ? Number(refund?.amount || 0) : 0
      if (!linked || Math.abs(red - expected) >= 0.01) reconciliationIssues += 1
      waivedAmount += red
      if (w.status === 'PARTIALLY_APPROVED') reducedAmount += red
    }
  }

  const repeatOffenders = Array.from(repeatByEmployee.entries())
    .map(([employeeId, summary]) => ({ employeeId, ...summary }))
    .sort((a, b) => b.penaltyTotal - a.penaltyTotal)
    .slice(0, 8)

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
    reconciliationIssues,
    repeatOffenders,
    byRequestType: {
      fullWaive: waivers.filter(w => w.requestType === 'FULL_WAIVE').length,
      partialReduce: waivers.filter(w => w.requestType === 'PARTIAL_REDUCE').length,
      reconsideration: waivers.filter(w => w.requestType === 'RECONSIDERATION').length,
    },
  }
}
