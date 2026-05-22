import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceSelfieDto } from '@/lib/attendance'
import { resolveAttendanceImageRefForDisplay } from '@/lib/attendance-photo-storage'
import { resolveSelfieForAdminReview } from '@/lib/attendance-selfie-review'
import { notifyUser } from '@/lib/notifications'
import { withApiRoute } from '@/lib/core/safe-api'
import { logEvent } from '@/lib/logger'
import { attachAttendanceContext } from '@/lib/sentry/capture'

export const GET = withApiRoute('attendance.selfies.detail', async (req: NextRequest, ctxParam) => {
  const { params } = ctxParam as { params: { id: string } }
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requestId = req.headers.get('x-request-id') || undefined
  const requestedBusinessId = url.searchParams.get('business_id')?.trim() || ctx.businessIds[0] || null
  await attachAttendanceContext({
    businessId: requestedBusinessId || ctx.businessIds[0],
    attendanceRecordId: params.id,
    requestId,
    route: 'attendance.selfies.detail',
  })

  const attendanceRecordId = url.searchParams.get('attendance_record_id')
  const lookup = await resolveSelfieForAdminReview({
    id: params.id,
    businessId: requestedBusinessId,
    attendanceRecordId,
    isSuperAdmin: ctx.role === 'SUPER_ADMIN',
  })
  if (!lookup.ok) {
    logEvent('warn', 'attendance.review.photo_missing', {
      requestId,
      businessId: requestedBusinessId,
      selfieId: params.id,
      attendanceRecordId: attendanceRecordId || params.id,
      lookup: 'detail',
      code: lookup.code,
    })
    return NextResponse.json(
      {
        ok: false,
        error: lookup.error,
        code: lookup.code,
        diagnostic: lookup.diagnostic,
      },
      { status: lookup.status },
    )
  }

  const selfie = lookup.selfie
  const imageUrl = await resolveAttendanceImageRefForDisplay(selfie.imageDataUrl)
  if (!imageUrl) {
    logEvent('warn', 'attendance.review.storage_missing', {
      requestId,
      businessId: selfie.businessId,
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
  const requestedBusinessId = String(body.business_id || '').trim() || null
  await attachAttendanceContext({
    businessId: requestedBusinessId || ctx.businessIds[0],
    attendanceRecordId: body.attendance_record_id || params.id,
    requestId,
    route: 'attendance.selfies.review',
  })

  const lookup = await resolveSelfieForAdminReview({
    id: params.id,
    businessId: requestedBusinessId,
    attendanceRecordId: body.attendance_record_id || null,
    isSuperAdmin: true,
  })
  if (!lookup.ok) {
    logEvent('warn', 'attendance.review.photo_missing', {
      requestId,
      businessId: requestedBusinessId,
      selfieId: params.id,
      attendanceRecordId: body.attendance_record_id || params.id,
      lookup: 'review',
      action: body.action,
      code: lookup.code,
    })
    return NextResponse.json(
      {
        error: lookup.error,
        code: lookup.code,
        diagnostic: lookup.diagnostic,
      },
      { status: lookup.status },
    )
  }

  const selfie = lookup.selfie
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
      businessId: selfie.businessId,
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
