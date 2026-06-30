import type { AttendanceException } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { attendanceDateFor, localMinutesFor } from '@/lib/attendance'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  resolveApprovalRequestById,
} from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { notifyUser } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'

/**
 * Step 3 of the attendance checkout-discipline feature (ALMA_LIFESTYLE only).
 *
 * The exception / permission button. A staff taps once to ask the owner to
 * waive today's attendance rules — field work, an early checkout, a late start.
 * When the owner APPROVES, every checkout gate (time / location / task) AND the
 * no-checkout fine are skipped for that staff on that day. An optional hour
 * window (startMinutes/endMinutes) narrows the waiver; null = the whole day.
 *
 * Everything stays behind the same kill-switch as Steps 1–2: the gate callers
 * only consult an exception when checkoutRulesEnabled(businessId) is already on.
 */

/**
 * Purpose of an exception. The scope decides which rules a waiver unlocks:
 *   - FULL_DAY       → all attendance rules waived for the day (legacy default)
 *   - EARLY_CHECKOUT → may leave before 8 PM / field work (checkout unlocked)
 *   - LATE_ARRIVAL   → came in late; explains the lateness only. It must NOT
 *                      unlock an early checkout — that was the bug.
 */
export type ExceptionScope = 'FULL_DAY' | 'EARLY_CHECKOUT' | 'LATE_ARRIVAL'
const EXCEPTION_SCOPES: ExceptionScope[] = ['FULL_DAY', 'EARLY_CHECKOUT', 'LATE_ARRIVAL']

// Scopes whose approval waives the checkout rules (time/location/task) and the
// no-checkout fine. A LATE_ARRIVAL waiver is deliberately absent here.
const CHECKOUT_WAIVING_SCOPES = new Set<ExceptionScope>(['FULL_DAY', 'EARLY_CHECKOUT'])

export function normalizeExceptionScope(value: unknown): ExceptionScope {
  const v = String(value || '').trim().toUpperCase()
  return (EXCEPTION_SCOPES as string[]).includes(v) ? (v as ExceptionScope) : 'FULL_DAY'
}

const SCOPE_LABEL: Record<ExceptionScope, string> = {
  FULL_DAY: 'সারাদিন সব নিয়ম মওকুফ',
  EARLY_CHECKOUT: 'আগে বের হওয়া / মাঠের কাজ',
  LATE_ARRIVAL: 'দেরিতে আসা',
}

function dateLabel(date: Date) {
  return date.toISOString().slice(0, 10)
}

function timeLabel(minutes: number) {
  const hh = Math.floor(minutes / 60)
  const mm = minutes % 60
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`
}

/**
 * True when the staff has an APPROVED exception covering `now` on the given
 * attendance date. A whole-day exception (no window) always matches; a windowed
 * exception matches only when the current local minute falls inside the window.
 */
export async function hasApprovedException(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
  now: Date = new Date(),
): Promise<boolean> {
  if (!userId) return false
  const ex = await prisma.attendanceException.findUnique({
    where: { businessId_userId_attendanceDate: { businessId, userId, attendanceDate } },
    select: { status: true, scope: true, startMinutes: true, endMinutes: true },
  })
  if (!ex || ex.status !== 'APPROVED') return false
  // A late-arrival waiver explains the lateness only — it must not unlock an
  // early checkout. Only FULL_DAY / EARLY_CHECKOUT scopes waive the checkout.
  if (!CHECKOUT_WAIVING_SCOPES.has(normalizeExceptionScope(ex.scope))) return false
  if (ex.startMinutes == null || ex.endMinutes == null) return true
  const nowMinutes = localMinutesFor(now)
  return nowMinutes >= ex.startMinutes && nowMinutes <= ex.endMinutes
}

export function attendanceExceptionDto(ex: AttendanceException) {
  return {
    id: ex.id,
    businessId: ex.businessId,
    userId: ex.userId,
    employeeId: ex.employeeId,
    attendanceDate: ex.attendanceDate.toISOString(),
    status: ex.status,
    scope: normalizeExceptionScope(ex.scope),
    startMinutes: ex.startMinutes,
    endMinutes: ex.endMinutes,
    reason: ex.reason,
    grantedDirect: ex.grantedDirect,
    adminNote: ex.adminNote,
    reviewedAt: ex.reviewedAt?.toISOString() || null,
    createdAt: ex.createdAt.toISOString(),
    updatedAt: ex.updatedAt.toISOString(),
  }
}

function windowLabel(startMinutes?: number | null, endMinutes?: number | null) {
  if (startMinutes == null || endMinutes == null) return 'সারাদিনের জন্য'
  return `${timeLabel(startMinutes)}–${timeLabel(endMinutes)} সময়ের জন্য`
}

export type SubmitExceptionInput = {
  businessId: string
  userId: string
  employeeId: string
  userName?: string
  reason: string
  scope?: ExceptionScope
  attendanceDate?: Date
  startMinutes?: number | null
  endMinutes?: number | null
}

export type SubmitExceptionResult =
  | { ok: true; exception: ReturnType<typeof attendanceExceptionDto>; created: boolean; reopened?: boolean }
  | { error: string; status: number }

/**
 * Staff requests an exception for a day. Reuses the row on re-request after a
 * rejection/cancellation (one row per staff per day). Creates a central
 * approval (ATTENDANCE_EXCEPTION) that notifies the owner via Telegram + the
 * Approvals center.
 */
export async function submitExceptionRequest(input: SubmitExceptionInput): Promise<SubmitExceptionResult> {
  const reason = String(input.reason || '').trim()
  if (reason.length < 3) {
    return { error: 'কারণ লিখুন (অন্তত ৩ অক্ষর)।', status: 400 }
  }
  const attendanceDate = input.attendanceDate ?? attendanceDateFor()
  const scope = normalizeExceptionScope(input.scope)
  const startMinutes = input.startMinutes ?? null
  const endMinutes = input.endMinutes ?? null
  if ((startMinutes == null) !== (endMinutes == null)) {
    return { error: 'সময়সীমা দিতে হলে শুরু ও শেষ দুটোই দিন।', status: 400 }
  }
  if (startMinutes != null && endMinutes != null && startMinutes >= endMinutes) {
    return { error: 'শুরুর সময় শেষের সময়ের আগে হতে হবে।', status: 400 }
  }

  const existing = await prisma.attendanceException.findUnique({
    where: { businessId_userId_attendanceDate: { businessId: input.businessId, userId: input.userId, attendanceDate } },
  })

  if (existing && (existing.status === 'PENDING' || existing.status === 'APPROVED')) {
    return {
      error: existing.status === 'APPROVED'
        ? 'আজকের জন্য আপনার অনুমতি ইতিমধ্যে অনুমোদিত আছে।'
        : 'আপনার অনুমতির অনুরোধ ইতিমধ্যে পাঠানো হয়েছে — মালিকের অনুমোদনের অপেক্ষায়।',
      status: 409,
    }
  }

  let row: AttendanceException
  let reopened = false
  if (existing) {
    reopened = true
    row = await prisma.attendanceException.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        scope,
        reason: reason.slice(0, 1200),
        startMinutes,
        endMinutes,
        grantedDirect: false,
        adminNote: null,
        reviewedById: null,
        reviewedAt: null,
      },
    })
  } else {
    row = await prisma.attendanceException.create({
      data: {
        businessId: input.businessId,
        userId: input.userId,
        employeeId: input.employeeId,
        attendanceDate,
        scope,
        reason: reason.slice(0, 1200),
        startMinutes,
        endMinutes,
      },
    })
  }

  const employeeName = input.userName || input.employeeId
  await createApprovalRequest({
    module: APPROVAL_MODULES.PAYROLL,
    type: APPROVAL_TYPES.ATTENDANCE_EXCEPTION,
    businessId: input.businessId,
    entityId: row.id,
    requestedBy: input.userId,
    reason: reason.slice(0, 1200),
    priority: 'HIGH',
    actionUrl: '/approvals',
    title: 'উপস্থিতি অনুমতির অনুরোধ',
    message: `${employeeName} (${input.employeeId}) ${dateLabel(attendanceDate)} তারিখে ${windowLabel(startMinutes, endMinutes)} উপস্থিতির নিয়ম মওকুফের অনুমতি চেয়েছেন। উদ্দেশ্য: ${SCOPE_LABEL[scope]}। কারণ: ${reason.slice(0, 200)}`,
    payloadSnapshot: {
      exceptionId: row.id,
      employeeId: input.employeeId,
      employeeName,
      attendanceDate: dateLabel(attendanceDate),
      scope,
      startMinutes,
      endMinutes,
    },
  })

  dispatchApprovalsUpdated()
  return { ok: true, exception: attendanceExceptionDto(row), created: !existing, reopened }
}

export type ProcessExceptionResult =
  | { ok: true; exception: ReturnType<typeof attendanceExceptionDto>; approval: unknown; rejected?: boolean }
  | { error: string; status: number; code?: string }

/** Owner resolves an ATTENDANCE_EXCEPTION approval. */
export async function processExceptionApproval(input: {
  approvalId: string
  exceptionId: string
  action: 'APPROVE' | 'REJECT'
  actorUserId: string
  note?: string
}): Promise<ProcessExceptionResult> {
  const note = String(input.note || '').trim().slice(0, 800) || null
  const ex = await prisma.attendanceException.findUnique({ where: { id: input.exceptionId } })
  if (!ex) return { error: 'অনুমতির অনুরোধ পাওয়া যায়নি।', status: 404, code: 'not_found' }

  const status = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
  const updated = await prisma.attendanceException.update({
    where: { id: ex.id },
    data: {
      status,
      adminNote: note,
      reviewedById: input.actorUserId,
      reviewedAt: new Date(),
    },
  })

  const approval = await resolveApprovalRequestById({
    id: input.approvalId,
    status,
    actorUserId: input.actorUserId,
    reason: note || (status === 'APPROVED' ? 'Exception approved' : 'Exception rejected'),
  })

  const label = dateLabel(ex.attendanceDate)
  await notifyUser({
    userId: ex.userId,
    businessId: ex.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: status === 'APPROVED' ? 'HIGH' : 'NORMAL',
    title: status === 'APPROVED' ? 'অনুমতি অনুমোদিত' : 'অনুমতি প্রত্যাখ্যাত',
    message: status === 'APPROVED'
      ? `${label} তারিখের জন্য ${windowLabel(ex.startMinutes, ex.endMinutes)} আপনার উপস্থিতির নিয়ম মওকুফ করা হয়েছে। এখন স্বাভাবিকভাবে চেক-আউট করতে পারবেন, কোনো জরিমানা হবে না।`
      : `${label} তারিখের অনুমতির অনুরোধ মালিক প্রত্যাখ্যান করেছেন। স্বাভাবিক উপস্থিতির নিয়ম প্রযোজ্য থাকবে।`,
    actionUrl: '/portal',
  }).catch(() => {})

  logEvent('info', 'attendance.exception.resolved', {
    exceptionId: ex.id,
    status,
    actorUserId: input.actorUserId,
  })

  dispatchApprovalsUpdated()
  return { ok: true, exception: attendanceExceptionDto(updated), approval, rejected: status === 'REJECTED' }
}

/**
 * Owner directly grants an exception (no staff request first). Idempotent on
 * the one-row-per-staff-per-day unique key.
 */
export async function grantExceptionDirect(input: {
  businessId: string
  userId: string
  employeeId: string
  actorUserId: string
  reason?: string
  scope?: ExceptionScope
  attendanceDate?: Date
  startMinutes?: number | null
  endMinutes?: number | null
}): Promise<{ ok: true; exception: ReturnType<typeof attendanceExceptionDto> }> {
  const attendanceDate = input.attendanceDate ?? attendanceDateFor()
  const scope = normalizeExceptionScope(input.scope)
  const reason = String(input.reason || 'মালিক সরাসরি অনুমতি দিয়েছেন').trim().slice(0, 1200)
  const row = await prisma.attendanceException.upsert({
    where: { businessId_userId_attendanceDate: { businessId: input.businessId, userId: input.userId, attendanceDate } },
    create: {
      businessId: input.businessId,
      userId: input.userId,
      employeeId: input.employeeId,
      attendanceDate,
      status: 'APPROVED',
      scope,
      startMinutes: input.startMinutes ?? null,
      endMinutes: input.endMinutes ?? null,
      reason,
      grantedDirect: true,
      reviewedById: input.actorUserId,
      reviewedAt: new Date(),
    },
    update: {
      status: 'APPROVED',
      scope,
      startMinutes: input.startMinutes ?? null,
      endMinutes: input.endMinutes ?? null,
      reason,
      grantedDirect: true,
      adminNote: null,
      reviewedById: input.actorUserId,
      reviewedAt: new Date(),
    },
  })

  await notifyUser({
    userId: input.userId,
    businessId: input.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: 'HIGH',
    title: 'অনুমতি দেওয়া হয়েছে',
    message: `${dateLabel(attendanceDate)} তারিখের জন্য ${windowLabel(input.startMinutes, input.endMinutes)} মালিক আপনাকে উপস্থিতির নিয়ম মওকুফের অনুমতি দিয়েছেন।`,
    actionUrl: '/portal',
  }).catch(() => {})

  dispatchApprovalsUpdated()
  return { ok: true, exception: attendanceExceptionDto(row) }
}
