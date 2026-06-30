import { NextRequest } from 'next/server'
import type { AttendanceLeaveKind } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  attendanceLeaveDto,
  grantLeaveDirect,
  submitLeaveRequest,
} from '@/lib/attendance-leave'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

const VALID_KINDS: AttendanceLeaveKind[] = ['FULL_DAY', 'DATE_RANGE', 'HOURS', 'SHIFTED_START']

// GET — return the caller's recent leave applications (so the portal can show status).
export const GET = withApiRoute('attendance.leave.list', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth
  if (!ctx.employeeId) return apiDataSuccess({ leaves: [] })

  const rows = await prisma.attendanceLeave.findMany({
    where: {
      businessId: ctx.businessIds[0],
      userId: ctx.userId,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return apiDataSuccess({ leaves: rows.map(attendanceLeaveDto) })
})

// POST — staff applies for leave, OR (Super Admin / owner) directly grants one.
export const POST = withApiRoute('attendance.leave.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    kind?: AttendanceLeaveKind
    start_date?: string
    end_date?: string
    start_minutes?: number | null
    end_minutes?: number | null
    reason?: string
    // Direct-grant (owner) fields:
    grant?: boolean
    target_user_id?: string
    target_employee_id?: string
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const kind: AttendanceLeaveKind = VALID_KINDS.includes(body.kind as AttendanceLeaveKind)
    ? (body.kind as AttendanceLeaveKind)
    : 'FULL_DAY'

  if (!body.start_date) {
    return apiFailure('invalid_request', 'ছুটির শুরুর তারিখ দিন।', { status: 400 })
  }

  // Owner direct grant path.
  if (body.grant) {
    if (!ctx.isAdmin && !ctx.isSystemOwner) {
      return apiFailure('forbidden', 'শুধু মালিক সরাসরি ছুটি দিতে পারেন।', { status: 403 })
    }
    if (!body.target_user_id || !body.target_employee_id) {
      return apiFailure('invalid_request', 'কোন স্টাফকে ছুটি দেবেন তা নির্বাচন করুন।', { status: 400 })
    }
    const result = await grantLeaveDirect({
      businessId: ctx.businessIds[0],
      userId: body.target_user_id,
      employeeId: body.target_employee_id,
      actorUserId: ctx.userId,
      kind,
      startDateYmd: body.start_date,
      endDateYmd: body.end_date,
      startMinutes: body.start_minutes ?? null,
      endMinutes: body.end_minutes ?? null,
      reason: body.reason,
    })
    if ('error' in result) {
      return apiFailure('leave_failed', result.error, { status: result.status })
    }
    return apiDataSuccess({ leave: result.leave, granted: true })
  }

  // Staff self-request path.
  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not apply for leave.', { status: 403 })
  }
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'আপনার অ্যাকাউন্ট কোনো HR এমপ্লয়ি আইডির সাথে যুক্ত নয়।', { status: 400 })
  }

  const result = await submitLeaveRequest({
    businessId: ctx.businessIds[0],
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    kind,
    startDateYmd: body.start_date,
    endDateYmd: body.end_date,
    startMinutes: body.start_minutes ?? null,
    endMinutes: body.end_minutes ?? null,
    reason: String(body.reason || ''),
  })

  if ('error' in result) {
    return apiFailure('leave_failed', result.error, { status: result.status })
  }
  return apiDataSuccess({ leave: result.leave })
})
