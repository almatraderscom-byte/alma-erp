import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceSelfieDto } from '@/lib/attendance'
import { resolveAttendanceImageRefForDisplay } from '@/lib/attendance-photo-storage'
import { notifyUser } from '@/lib/notifications'
import { withApiRoute } from '@/lib/core/safe-api'
import { logEvent } from '@/lib/logger'
import { attachAttendanceContext } from '@/lib/sentry/capture'

async function findSelfieForAdmin(businessId: string, id: string, attendanceRecordId?: string | null) {
  const byId = await prisma.attendanceSelfieVerification.findFirst({
    where: { id, businessId },
    include: { attendanceRecord: true },
  })
  if (byId) return byId

  if (attendanceRecordId) {
    return prisma.attendanceSelfieVerification.findFirst({
      where: { attendanceRecordId, businessId },
      orderBy: { capturedAt: 'desc' },
      include: { attendanceRecord: true },
    })
  }

  return prisma.attendanceSelfieVerification.findFirst({
    where: { attendanceRecordId: id, businessId },
    orderBy: { capturedAt: 'desc' },
    include: { attendanceRecord: true },
  })
}

export const GET = withApiRoute('attendance.selfies.detail', async (req: NextRequest, ctxParam) => {
  const { params } = ctxParam as { params: { id: string } }
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requestId = req.headers.get('x-request-id') || undefined
  await attachAttendanceContext({
    businessId: ctx.businessIds[0],
    attendanceRecordId: params.id,
    requestId,
    route: 'attendance.selfies.detail',
  })

  const attendanceRecordId = url.searchParams.get('attendance_record_id')
  const selfie = await findSelfieForAdmin(ctx.businessIds[0], params.id, attendanceRecordId)
  if (!selfie) {
    logEvent('warn', 'attendance.review.photo_missing', {
      requestId,
      businessId: ctx.businessIds[0],
      selfieId: params.id,
      attendanceRecordId: attendanceRecordId || params.id,
      lookup: 'detail',
    })
    return NextResponse.json({
      ok: false,
      error: 'Verification photo not found.',
      code: 'photo_not_found',
      diagnostic: 'No selfie row for this id or attendance record. Employee may need to check in again.',
    }, { status: 404 })
  }

  const imageUrl = await resolveAttendanceImageRefForDisplay(selfie.imageDataUrl)
  if (!imageUrl) {
    logEvent('warn', 'attendance.review.storage_missing', {
      requestId,
      businessId: ctx.businessIds[0],
      selfieId: selfie.id,
      attendanceRecordId: selfie.attendanceRecordId,
      storageRef: selfie.imageDataUrl?.slice(0, 120),
    })
  }
  return NextResponse.json({
    ok: true,
    selfie: {
      ...attendanceSelfieDto(selfie),
      imageUrl,
      imageMissing: !imageUrl,
    },
  })
})

export const PATCH = withApiRoute('attendance.selfies.review', async (req: NextRequest, ctxParam) => {
  const { params } = ctxParam as { params: { id: string } }
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    action?: 'APPROVE' | 'REJECT'
    note?: string
    attendance_record_id?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Only Super Admin can review verification selfies.' }, { status: 403 })
  }
  if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
    return NextResponse.json({ error: 'action APPROVE|REJECT required' }, { status: 400 })
  }

  const requestId = req.headers.get('x-request-id') || undefined
  await attachAttendanceContext({
    businessId: ctx.businessIds[0],
    attendanceRecordId: body.attendance_record_id || params.id,
    requestId,
    route: 'attendance.selfies.review',
  })

  const selfie = await findSelfieForAdmin(
    ctx.businessIds[0],
    params.id,
    body.attendance_record_id || null,
  )
  if (!selfie) {
    logEvent('warn', 'attendance.review.photo_missing', {
      requestId,
      businessId: ctx.businessIds[0],
      selfieId: params.id,
      attendanceRecordId: body.attendance_record_id || params.id,
      lookup: 'review',
      action: body.action,
    })
    return NextResponse.json({
      error: 'Verification photo not found.',
      code: 'photo_not_found',
      diagnostic:
        'No stored verification asset for this request. If check-in succeeded today, ask the employee to open My Desk and retry verification.',
    }, { status: 404 })
  }

  const now = new Date()
  const note = String(body.note || '').trim().slice(0, 500) || null
  const updated = await prisma.attendanceSelfieVerification.update({
    where: { id: selfie.id },
    data: {
      reviewedAt: now,
      reviewedById: ctx.userId,
      reviewNote: note,
    },
  })

  await prisma.attendanceRecord.update({
    where: { id: selfie.attendanceRecordId },
    data: {
      verificationRequired: false,
      trustStatus: body.action === 'APPROVE' ? 'TRUSTED' : 'WARNING',
    },
  })

  await notifyUser({
    userId: selfie.userId,
    businessId: selfie.businessId,
    type: 'PAYROLL_ALERT',
    priority: 'HIGH',
    title: body.action === 'APPROVE' ? 'Attendance verification approved' : 'Attendance verification rejected',
    message: body.action === 'APPROVE'
      ? 'Your verification photo was approved by admin.'
      : note || 'Your verification photo was rejected. Contact admin if you need help.',
    actionUrl: '/portal',
  })

  const imageUrl = await resolveAttendanceImageRefForDisplay(updated.imageDataUrl)
  if (!imageUrl) {
    logEvent('warn', 'attendance.review.storage_missing', {
      requestId,
      businessId: ctx.businessIds[0],
      selfieId: updated.id,
      attendanceRecordId: updated.attendanceRecordId,
      storageRef: updated.imageDataUrl?.slice(0, 120),
      stage: 'post_review',
    })
  }
  return NextResponse.json({
    ok: true,
    selfie: {
      ...attendanceSelfieDto(updated),
      imageUrl,
      imageMissing: !imageUrl,
    },
  })
})
