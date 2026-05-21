import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceRecordDto } from '@/lib/attendance'
import { notifyUser } from '@/lib/notifications'
import { withApiRoute } from '@/lib/core/safe-api'
import { attachAttendanceContext } from '@/lib/sentry/capture'

export const POST = withApiRoute('attendance.verification_request', async (req: NextRequest, ctxParam) => {
  const { params } = ctxParam as { params: { id: string } }
  const body = (await req.json().catch(() => ({}))) as { business_id?: string; note?: string }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Only Super Admin can request attendance verification.' }, { status: 403 })
  }

  await attachAttendanceContext({
    businessId: ctx.businessIds[0],
    attendanceRecordId: params.id,
    requestId: req.headers.get('x-request-id') || undefined,
    route: 'attendance.verification_request',
  })

  const record = await prisma.attendanceRecord.update({
    where: { id: params.id },
    data: {
      verificationRequired: true,
      verificationRequestedById: ctx.userId,
      trustStatus: 'REQUIRES_VERIFICATION',
      suspiciousReasons: { push: 'ADMIN_REQUEST' },
    },
    include: { waiverRequests: true, selfieVerifications: true },
  })

  await notifyUser({
    userId: record.userId,
    businessId: record.businessId,
    type: 'PAYROLL_ALERT',
    priority: 'HIGH',
    title: 'Attendance verification requested',
    message: String(body.note || 'Super Admin requested a quick attendance selfie verification.').slice(0, 200),
    actionUrl: '/portal',
  })

  return NextResponse.json({ ok: true, record: attendanceRecordDto(record) })
})
