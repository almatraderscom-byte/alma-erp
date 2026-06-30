import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { attendanceDateFor } from '@/lib/attendance'
import {
  attendanceExceptionDto,
  grantExceptionDirect,
  normalizeExceptionScope,
  submitExceptionRequest,
} from '@/lib/attendance-exception'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

// GET — return the caller's exception for today (so the portal can show status).
export const GET = withApiRoute('attendance.exceptions.today', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth
  if (!ctx.employeeId) return apiDataSuccess({ exception: null })

  const attendanceDate = attendanceDateFor()
  const row = await prisma.attendanceException.findUnique({
    where: {
      businessId_userId_attendanceDate: {
        businessId: ctx.businessIds[0],
        userId: ctx.userId,
        attendanceDate,
      },
    },
  })
  return apiDataSuccess({ exception: row ? attendanceExceptionDto(row) : null })
})

// POST — staff requests an exception, OR (Super Admin) directly grants one.
export const POST = withApiRoute('attendance.exceptions.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    reason?: string
    scope?: string
    start_minutes?: number | null
    end_minutes?: number | null
    // Direct-grant (owner) fields:
    grant?: boolean
    target_user_id?: string
    target_employee_id?: string
  }>(req)
  const scope = normalizeExceptionScope(body.scope)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  // Owner direct grant path.
  if (body.grant) {
    if (!ctx.isAdmin && !ctx.isSystemOwner) {
      return apiFailure('forbidden', 'শুধু মালিক সরাসরি অনুমতি দিতে পারেন।', { status: 403 })
    }
    if (!body.target_user_id || !body.target_employee_id) {
      return apiFailure('invalid_request', 'কোন স্টাফকে অনুমতি দেবেন তা নির্বাচন করুন।', { status: 400 })
    }
    const result = await grantExceptionDirect({
      businessId: ctx.businessIds[0],
      userId: body.target_user_id,
      employeeId: body.target_employee_id,
      actorUserId: ctx.userId,
      reason: body.reason,
      scope,
      startMinutes: body.start_minutes ?? null,
      endMinutes: body.end_minutes ?? null,
    })
    return apiDataSuccess({ exception: result.exception, granted: true })
  }

  // Staff self-request path.
  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not request attendance exceptions.', { status: 403 })
  }
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'আপনার অ্যাকাউন্ট কোনো HR এমপ্লয়ি আইডির সাথে যুক্ত নয়।', { status: 400 })
  }

  const result = await submitExceptionRequest({
    businessId: ctx.businessIds[0],
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    reason: String(body.reason || ''),
    scope,
    startMinutes: body.start_minutes ?? null,
    endMinutes: body.end_minutes ?? null,
  })

  if ('error' in result) {
    return apiFailure('exception_failed', result.error, { status: result.status })
  }
  return apiDataSuccess({ exception: result.exception, reopened: result.reopened || false })
})
