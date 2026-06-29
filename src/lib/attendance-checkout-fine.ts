import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { attendanceDateFor } from '@/lib/attendance'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  resolveApprovalRequestById,
} from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { notifyUser } from '@/lib/notifications'
import { checkoutRulesEnabled, CHECKOUT_RULES_BUSINESS } from '@/lib/attendance-checkout-rules'
import { hasApprovedException } from '@/lib/attendance-exception'
import { logEvent } from '@/lib/logger'

/**
 * Step 2 of the attendance checkout-discipline feature (ALMA_LIFESTYLE only).
 *
 * The 500৳ "no-checkout" fine. A staff who checked in but never checked out by
 * the end of the day owes a fine — but it is NEVER deducted automatically. A
 * nightly sweep (11:00 PM Asia/Dhaka) raises ONE approval request to the owner
 * per offending record. Only when the owner APPROVES does the 500৳ land on the
 * staff wallet. The owner can REJECT (no fine), and the staff can appeal an
 * approved fine through the existing AttendanceWaiverRequest flow.
 *
 * Everything is behind the same kill-switch as Step 1 (checkoutRulesEnabled),
 * so production stays untouched until the owner flips it on.
 */

export const NO_CHECKOUT_FINE_AMOUNT = 500
export const NO_CHECKOUT_FINE_SOURCE = 'attendance_no_checkout_fine'

export function noCheckoutFineSourceRef(businessId: string, employeeId: string, attendanceDate: Date) {
  return `attendance-nocheckout:${businessId}:${employeeId}:${attendanceDate.toISOString().slice(0, 10)}`
}

function dhakaDateLabel(date: Date) {
  return date.toISOString().slice(0, 10)
}

export type NoCheckoutSweepResult = {
  ok: boolean
  enabled: boolean
  attendanceDate: string
  scanned: number
  approvalsCreated: number
  skipped: number
  errors: number
}

/**
 * Nightly sweep — find ALMA_LIFESTYLE records for today where the staff checked
 * in but never checked out, and raise one owner approval each. Idempotent:
 * createApprovalRequest dedupes a PENDING row for the same entity, and we skip
 * records that already carry a posted fine.
 */
export async function sweepNoCheckoutFines(input?: { now?: Date }): Promise<NoCheckoutSweepResult> {
  const now = input?.now ?? new Date()
  const businessId = CHECKOUT_RULES_BUSINESS
  const attendanceDate = attendanceDateFor(now)
  const result: NoCheckoutSweepResult = {
    ok: true,
    enabled: checkoutRulesEnabled(businessId),
    attendanceDate: dhakaDateLabel(attendanceDate),
    scanned: 0,
    approvalsCreated: 0,
    skipped: 0,
    errors: 0,
  }

  if (!result.enabled) return result

  const records = await prisma.attendanceRecord.findMany({
    where: {
      businessId,
      attendanceDate,
      checkOutAt: null,
      isArchived: false,
      noCheckoutFineLedgerEntryId: null,
    },
    select: {
      id: true,
      businessId: true,
      userId: true,
      employeeId: true,
      attendanceDate: true,
      user: { select: { name: true } },
    },
  })
  result.scanned = records.length

  for (const record of records) {
    try {
      // Step 3 — skip staff with an owner-approved exception covering this day
      // (whole-day waiver; an hour-window exception does not excuse a missed
      // checkout for the whole day, so it is intentionally not matched at 11PM).
      if (await hasApprovedException(record.userId, businessId, record.attendanceDate, now)) {
        result.skipped += 1
        continue
      }

      // Skip if a non-pending (already resolved) approval exists for this record.
      const resolved = await prisma.approvalRequest.findFirst({
        where: {
          module: APPROVAL_MODULES.PAYROLL,
          type: APPROVAL_TYPES.NO_CHECKOUT_FINE,
          entityId: record.id,
          status: { in: ['APPROVED', 'REJECTED'] },
        },
        select: { id: true },
      })
      if (resolved) {
        result.skipped += 1
        continue
      }

      const employeeName = record.user?.name || record.employeeId
      const dateLabel = dhakaDateLabel(record.attendanceDate)
      const existing = await prisma.approvalRequest.findFirst({
        where: {
          module: APPROVAL_MODULES.PAYROLL,
          type: APPROVAL_TYPES.NO_CHECKOUT_FINE,
          entityId: record.id,
          status: 'PENDING',
        },
        select: { id: true },
      })

      await createApprovalRequest({
        module: APPROVAL_MODULES.PAYROLL,
        type: APPROVAL_TYPES.NO_CHECKOUT_FINE,
        businessId: record.businessId,
        entityId: record.id,
        requestedBy: record.userId,
        reason: `${employeeName} (${record.employeeId}) ${dateLabel} তারিখে চেক-ইন করেছেন কিন্তু চেক-আউট করেননি।`,
        priority: 'HIGH',
        actionUrl: '/approvals',
        title: 'চেক-আউট হয়নি — ৫০০৳ জরিমানা অনুমোদন',
        message: `${employeeName} (${record.employeeId}) ${dateLabel} তারিখে চেক-আউট করেননি। অনুমোদন করলে ৳${NO_CHECKOUT_FINE_AMOUNT.toLocaleString('en-BD')} জরিমানা কাটা হবে।`,
        payloadSnapshot: {
          attendanceRecordId: record.id,
          employeeId: record.employeeId,
          employeeName,
          attendanceDate: dateLabel,
          fineAmount: NO_CHECKOUT_FINE_AMOUNT,
        },
      })

      if (existing) {
        result.skipped += 1
      } else {
        result.approvalsCreated += 1
      }
    } catch (e) {
      result.errors += 1
      result.ok = false
      logEvent('error', 'attendance.nocheckout_fine.sweep_failed', {
        attendanceRecordId: record.id,
        employeeId: record.employeeId,
        message: (e as Error).message,
      })
    }
  }

  logEvent('info', 'attendance.nocheckout_fine.sweep', {
    attendanceDate: result.attendanceDate,
    scanned: result.scanned,
    approvalsCreated: result.approvalsCreated,
    skipped: result.skipped,
    errors: result.errors,
  })
  return result
}

export type ProcessNoCheckoutFineResult =
  | { ok: true; approval: unknown; fineAmount: number; ledgerEntryId: string | null; rejected?: boolean; alreadyApplied?: boolean }
  | { error: string; status: number; code?: string }

/**
 * Owner resolves a NO_CHECKOUT_FINE approval.
 *  - APPROVE → post the 500৳ PENALTY ledger entry, stamp it on the record, and
 *    notify the staff (Bangla) that the fine was applied + can be appealed.
 *  - REJECT  → resolve with no fine, notify the staff (Bangla) they were excused.
 */
export async function processNoCheckoutFine(input: {
  approvalId: string
  attendanceRecordId: string
  action: 'APPROVE' | 'REJECT'
  actorUserId: string
  note?: string
}): Promise<ProcessNoCheckoutFineResult> {
  const { approvalId, attendanceRecordId, action, actorUserId } = input
  const note = String(input.note || '').trim().slice(0, 800) || undefined

  const record = await prisma.attendanceRecord.findUnique({
    where: { id: attendanceRecordId },
    select: {
      id: true,
      businessId: true,
      userId: true,
      employeeId: true,
      attendanceDate: true,
      noCheckoutFineLedgerEntryId: true,
    },
  })
  if (!record) return { error: 'উপস্থিতির রেকর্ড পাওয়া যায়নি।', status: 404, code: 'not_found' }

  const dateLabel = dhakaDateLabel(record.attendanceDate)

  if (action === 'REJECT') {
    const approval = await resolveApprovalRequestById({
      id: approvalId,
      status: 'REJECTED',
      actorUserId,
      reason: note || 'No-checkout fine waived by owner',
    })
    await notifyUser({
      userId: record.userId,
      businessId: record.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'NORMAL',
      title: 'চেক-আউট জরিমানা মাফ',
      message: `${dateLabel} তারিখে চেক-আউট না করার জরিমানা মালিক মাফ করে দিয়েছেন। কোনো টাকা কাটা হয়নি।`,
      actionUrl: '/portal',
    }).catch(() => {})
    dispatchApprovalsUpdated()
    return { ok: true, approval, fineAmount: 0, ledgerEntryId: null, rejected: true }
  }

  // APPROVE — post the fine (idempotent on the record + ledger source/ref).
  if (record.noCheckoutFineLedgerEntryId) {
    const approval = await resolveApprovalRequestById({
      id: approvalId,
      status: 'APPROVED',
      actorUserId,
      reason: note || 'No-checkout fine approved',
    })
    return {
      ok: true,
      approval,
      fineAmount: NO_CHECKOUT_FINE_AMOUNT,
      ledgerEntryId: record.noCheckoutFineLedgerEntryId,
      alreadyApplied: true,
    }
  }

  const sourceRef = noCheckoutFineSourceRef(record.businessId, record.employeeId, record.attendanceDate)
  let ledgerEntryId: string
  try {
    const entry = await createCompensationLedgerEntry(
      {
        employeeId: record.employeeId,
        businessId: record.businessId,
        type: 'PENALTY',
        amount: NO_CHECKOUT_FINE_AMOUNT,
        effectiveDate: record.attendanceDate,
        createdById: actorUserId,
        approvedById: actorUserId,
        source: NO_CHECKOUT_FINE_SOURCE,
        sourceRef,
        note: `No-checkout fine · ${dateLabel}`,
      },
      { skipNotify: true },
    )
    ledgerEntryId = entry.id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.employeeLedgerEntry.findUnique({
        where: { source_sourceRef: { source: NO_CHECKOUT_FINE_SOURCE, sourceRef } },
        select: { id: true },
      })
      if (!existing) throw e
      ledgerEntryId = existing.id
    } else {
      throw e
    }
  }

  await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: {
      noCheckoutFineAmount: new Prisma.Decimal(NO_CHECKOUT_FINE_AMOUNT.toFixed(2)),
      noCheckoutFineLedgerEntryId: ledgerEntryId,
    },
  })

  const approval = await resolveApprovalRequestById({
    id: approvalId,
    status: 'APPROVED',
    actorUserId,
    reason: note || 'No-checkout fine approved',
  })

  await notifyUser({
    userId: record.userId,
    businessId: record.businessId,
    type: 'PAYROLL_ALERT',
    priority: 'HIGH',
    title: 'চেক-আউট না করার জরিমানা',
    message: `${dateLabel} তারিখে চেক-আউট না করায় ৳${NO_CHECKOUT_FINE_AMOUNT.toLocaleString('en-BD')} জরিমানা কাটা হয়েছে। ভুল মনে হলে পোর্টাল থেকে আপিল করতে পারেন।`,
    actionUrl: '/portal',
  }).catch(() => {})

  dispatchApprovalsUpdated()
  return { ok: true, approval, fineAmount: NO_CHECKOUT_FINE_AMOUNT, ledgerEntryId }
}
