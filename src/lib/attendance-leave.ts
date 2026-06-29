import type { AttendanceLeave, AttendanceLeaveKind } from '@prisma/client'
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
 * Step 4 of the attendance checkout-discipline feature (ALMA_LIFESTYLE only).
 *
 * Leave application. A staff applies for leave — a single day, a date range, a
 * few hours, or a shifted start (begin 11:00 instead of 9:30) — and the owner
 * approves (or grants directly). While an APPROVED leave covers a day:
 *   - the checkout gates (time / location / task) are waived;
 *   - the late check-in penalty is waived;
 *   - whole-day / range leave also skips the no-checkout fine (the staff is
 *     absent). HOURS / SHIFTED_START leave does NOT excuse a missed checkout —
 *     they still worked part of the day — so the no-checkout sweep applies.
 *
 * Everything stays behind the same kill-switch as Steps 1–3.
 */

function dateLabel(date: Date) {
  return date.toISOString().slice(0, 10)
}

function timeLabel(minutes: number) {
  const hh = Math.floor(minutes / 60)
  const mm = minutes % 60
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`
}

function isWholeDayKind(kind: AttendanceLeaveKind) {
  return kind === 'FULL_DAY' || kind === 'DATE_RANGE'
}

/**
 * The APPROVED leave covering `attendanceDate` for this staff, or null.
 * (One staff rarely has overlapping leaves; we take the first match.)
 */
export async function getApprovedLeaveForDate(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
): Promise<AttendanceLeave | null> {
  if (!userId) return null
  return prisma.attendanceLeave.findFirst({
    where: {
      businessId,
      userId,
      status: 'APPROVED',
      startDate: { lte: attendanceDate },
      endDate: { gte: attendanceDate },
    },
    orderBy: { startDate: 'desc' },
  })
}

/** Does an approved leave waive the checkout gates for this staff right now? */
export async function leaveWaivesCheckout(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
  now: Date = new Date(),
): Promise<boolean> {
  const leave = await getApprovedLeaveForDate(userId, businessId, attendanceDate)
  if (!leave) return false
  if (isWholeDayKind(leave.kind)) return true
  if (leave.startMinutes == null || leave.endMinutes == null) return true
  const nowMinutes = localMinutesFor(now)
  return nowMinutes >= leave.startMinutes && nowMinutes <= leave.endMinutes
}

/** Does an approved leave waive the late check-in penalty for this staff today? */
export async function leaveWaivesLatePenalty(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
): Promise<boolean> {
  // Any approved leave covering the day excuses lateness — the owner has
  // explicitly permitted a shifted start / hours / full day off.
  return Boolean(await getApprovedLeaveForDate(userId, businessId, attendanceDate))
}

/** Does an approved WHOLE-DAY leave excuse a missed checkout (skip the fine)? */
export async function leaveSkipsNoCheckoutFine(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
): Promise<boolean> {
  const leave = await getApprovedLeaveForDate(userId, businessId, attendanceDate)
  return Boolean(leave && isWholeDayKind(leave.kind))
}

export function attendanceLeaveDto(leave: AttendanceLeave) {
  return {
    id: leave.id,
    businessId: leave.businessId,
    userId: leave.userId,
    employeeId: leave.employeeId,
    kind: leave.kind,
    startDate: leave.startDate.toISOString(),
    endDate: leave.endDate.toISOString(),
    startMinutes: leave.startMinutes,
    endMinutes: leave.endMinutes,
    status: leave.status,
    reason: leave.reason,
    grantedDirect: leave.grantedDirect,
    adminNote: leave.adminNote,
    reviewedAt: leave.reviewedAt?.toISOString() || null,
    createdAt: leave.createdAt.toISOString(),
    updatedAt: leave.updatedAt.toISOString(),
  }
}

function kindLabel(kind: AttendanceLeaveKind, startMinutes?: number | null, endMinutes?: number | null) {
  if (kind === 'SHIFTED_START' && startMinutes != null) return `দেরিতে শুরু (${timeLabel(startMinutes)} থেকে)`
  if (kind === 'HOURS' && startMinutes != null && endMinutes != null) {
    return `${timeLabel(startMinutes)}–${timeLabel(endMinutes)} সময়ের ছুটি`
  }
  if (kind === 'DATE_RANGE') return 'কয়েকদিনের ছুটি'
  return 'একদিনের ছুটি'
}

/** UTC-midnight of a Dhaka YYYY-MM-DD string. */
function parseDhakaDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

export type SubmitLeaveInput = {
  businessId: string
  userId: string
  employeeId: string
  userName?: string
  kind: AttendanceLeaveKind
  startDateYmd: string
  endDateYmd?: string
  startMinutes?: number | null
  endMinutes?: number | null
  reason: string
}

export type SubmitLeaveResult =
  | { ok: true; leave: ReturnType<typeof attendanceLeaveDto> }
  | { error: string; status: number }

function validateLeaveWindow(input: {
  kind: AttendanceLeaveKind
  startDate: Date
  endDate: Date
  startMinutes: number | null
  endMinutes: number | null
}): { ok: true } | { error: string; status: number } {
  if (input.endDate < input.startDate) {
    return { error: 'শেষ তারিখ শুরুর তারিখের আগে হতে পারে না।', status: 400 }
  }
  if (input.kind === 'HOURS' || input.kind === 'SHIFTED_START') {
    if (input.startMinutes == null) {
      return { error: 'সময় (ঘণ্টা) নির্বাচন করুন।', status: 400 }
    }
    if (input.kind === 'HOURS') {
      if (input.endMinutes == null || input.startMinutes >= input.endMinutes) {
        return { error: 'ছুটির শুরু ও শেষ সময় ঠিকভাবে দিন।', status: 400 }
      }
    }
  }
  return { ok: true }
}

export async function submitLeaveRequest(input: SubmitLeaveInput): Promise<SubmitLeaveResult> {
  const reason = String(input.reason || '').trim()
  if (reason.length < 3) return { error: 'ছুটির কারণ লিখুন (অন্তত ৩ অক্ষর)।', status: 400 }

  const startDate = parseDhakaDate(input.startDateYmd)
  if (!startDate) return { error: 'শুরুর তারিখ ঠিক নয়।', status: 400 }
  const endDate = input.endDateYmd ? parseDhakaDate(input.endDateYmd) : startDate
  if (!endDate) return { error: 'শেষের তারিখ ঠিক নয়।', status: 400 }

  const startMinutes = input.startMinutes ?? null
  const endMinutes = input.endMinutes ?? null
  const valid = validateLeaveWindow({ kind: input.kind, startDate, endDate, startMinutes, endMinutes })
  if ('error' in valid) return valid

  const row = await prisma.attendanceLeave.create({
    data: {
      businessId: input.businessId,
      userId: input.userId,
      employeeId: input.employeeId,
      kind: input.kind,
      startDate,
      endDate,
      startMinutes,
      endMinutes,
      reason: reason.slice(0, 1200),
    },
  })

  const employeeName = input.userName || input.employeeId
  const range = dateLabel(startDate) === dateLabel(endDate)
    ? dateLabel(startDate)
    : `${dateLabel(startDate)} – ${dateLabel(endDate)}`
  await createApprovalRequest({
    module: APPROVAL_MODULES.PAYROLL,
    type: APPROVAL_TYPES.ATTENDANCE_LEAVE,
    businessId: input.businessId,
    entityId: row.id,
    requestedBy: input.userId,
    reason: reason.slice(0, 1200),
    priority: 'HIGH',
    actionUrl: '/approvals',
    title: 'ছুটির আবেদন',
    message: `${employeeName} (${input.employeeId}) ${range} তারিখে ${kindLabel(input.kind, startMinutes, endMinutes)} চেয়েছেন। কারণ: ${reason.slice(0, 200)}`,
    payloadSnapshot: {
      leaveId: row.id,
      employeeId: input.employeeId,
      employeeName,
      kind: input.kind,
      startDate: dateLabel(startDate),
      endDate: dateLabel(endDate),
      startMinutes,
      endMinutes,
    },
  })

  dispatchApprovalsUpdated()
  return { ok: true, leave: attendanceLeaveDto(row) }
}

export type ProcessLeaveResult =
  | { ok: true; leave: ReturnType<typeof attendanceLeaveDto>; approval: unknown; rejected?: boolean }
  | { error: string; status: number; code?: string }

export async function processLeaveApproval(input: {
  approvalId: string
  leaveId: string
  action: 'APPROVE' | 'REJECT'
  actorUserId: string
  note?: string
}): Promise<ProcessLeaveResult> {
  const note = String(input.note || '').trim().slice(0, 800) || null
  const leave = await prisma.attendanceLeave.findUnique({ where: { id: input.leaveId } })
  if (!leave) return { error: 'ছুটির আবেদন পাওয়া যায়নি।', status: 404, code: 'not_found' }

  const status = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
  const updated = await prisma.attendanceLeave.update({
    where: { id: leave.id },
    data: { status, adminNote: note, reviewedById: input.actorUserId, reviewedAt: new Date() },
  })

  const approval = await resolveApprovalRequestById({
    id: input.approvalId,
    status,
    actorUserId: input.actorUserId,
    reason: note || (status === 'APPROVED' ? 'Leave approved' : 'Leave rejected'),
  })

  const range = dateLabel(leave.startDate) === dateLabel(leave.endDate)
    ? dateLabel(leave.startDate)
    : `${dateLabel(leave.startDate)} – ${dateLabel(leave.endDate)}`
  await notifyUser({
    userId: leave.userId,
    businessId: leave.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: status === 'APPROVED' ? 'HIGH' : 'NORMAL',
    title: status === 'APPROVED' ? 'ছুটি অনুমোদিত' : 'ছুটি প্রত্যাখ্যাত',
    message: status === 'APPROVED'
      ? `${range} তারিখের ${kindLabel(leave.kind, leave.startMinutes, leave.endMinutes)} অনুমোদিত হয়েছে। এই সময়ে কোনো জরিমানা হবে না।`
      : `${range} তারিখের ছুটির আবেদন মালিক প্রত্যাখ্যান করেছেন। স্বাভাবিক উপস্থিতির নিয়ম প্রযোজ্য থাকবে।`,
    actionUrl: '/portal',
  }).catch(() => {})

  logEvent('info', 'attendance.leave.resolved', { leaveId: leave.id, status, actorUserId: input.actorUserId })
  dispatchApprovalsUpdated()
  return { ok: true, leave: attendanceLeaveDto(updated), approval, rejected: status === 'REJECTED' }
}

export async function grantLeaveDirect(input: {
  businessId: string
  userId: string
  employeeId: string
  actorUserId: string
  kind: AttendanceLeaveKind
  startDateYmd: string
  endDateYmd?: string
  startMinutes?: number | null
  endMinutes?: number | null
  reason?: string
}): Promise<{ ok: true; leave: ReturnType<typeof attendanceLeaveDto> } | { error: string; status: number }> {
  const startDate = parseDhakaDate(input.startDateYmd)
  if (!startDate) return { error: 'শুরুর তারিখ ঠিক নয়।', status: 400 }
  const endDate = input.endDateYmd ? parseDhakaDate(input.endDateYmd) : startDate
  if (!endDate) return { error: 'শেষের তারিখ ঠিক নয়।', status: 400 }
  const startMinutes = input.startMinutes ?? null
  const endMinutes = input.endMinutes ?? null
  const valid = validateLeaveWindow({ kind: input.kind, startDate, endDate, startMinutes, endMinutes })
  if ('error' in valid) return valid

  const row = await prisma.attendanceLeave.create({
    data: {
      businessId: input.businessId,
      userId: input.userId,
      employeeId: input.employeeId,
      kind: input.kind,
      startDate,
      endDate,
      startMinutes,
      endMinutes,
      status: 'APPROVED',
      reason: String(input.reason || 'মালিক সরাসরি ছুটি দিয়েছেন').slice(0, 1200),
      grantedDirect: true,
      reviewedById: input.actorUserId,
      reviewedAt: new Date(),
    },
  })

  const range = dateLabel(startDate) === dateLabel(endDate)
    ? dateLabel(startDate)
    : `${dateLabel(startDate)} – ${dateLabel(endDate)}`
  await notifyUser({
    userId: input.userId,
    businessId: input.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: 'HIGH',
    title: 'ছুটি দেওয়া হয়েছে',
    message: `${range} তারিখের ${kindLabel(input.kind, startMinutes, endMinutes)} মালিক আপনাকে দিয়েছেন। এই সময়ে কোনো জরিমানা হবে না।`,
    actionUrl: '/portal',
  }).catch(() => {})

  dispatchApprovalsUpdated()
  return { ok: true, leave: attendanceLeaveDto(row) }
}
