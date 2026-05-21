import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceSelfieDto } from '@/lib/attendance'
import {
  attendancePhotoStorageReady,
  prepareVerificationSelfieAssets,
} from '@/lib/attendance-photo-storage'
import { logEvent } from '@/lib/logger'

const MAX_SELFIE_BYTES = 180_000

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rows = await prisma.attendanceSelfieVerification.findMany({
    where: { businessId: ctx.businessIds[0] },
    orderBy: { capturedAt: 'desc' },
    take: 12,
  })
  return NextResponse.json({ selfies: rows.map(attendanceSelfieDto) })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    attendance_record_id?: string
    image_data_url?: string
    content_type?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.isSystemOwner) {
    return NextResponse.json({ error: 'System owner accounts do not use employee selfie verification.' }, { status: 403 })
  }
  if (!ctx.employeeId) return NextResponse.json({ error: 'Employee ID is required.' }, { status: 400 })

  const imageDataUrl = String(body.image_data_url || '')
  const estimatedBytes = Math.ceil((imageDataUrl.length * 3) / 4)
  if (!body.attendance_record_id || !imageDataUrl.startsWith('data:image/')) {
    return NextResponse.json({ error: 'Attendance record and selfie image are required.' }, { status: 400 })
  }
  if (estimatedBytes > MAX_SELFIE_BYTES) {
    return NextResponse.json({ error: 'Selfie image is too large. Please retake it.' }, { status: 413 })
  }

  if (!attendancePhotoStorageReady()) {
    return NextResponse.json(
      { error: 'Photo storage is not configured. Contact admin — verification was not saved.' },
      { status: 503 },
    )
  }

  const record = await prisma.attendanceRecord.findFirst({
    where: {
      id: body.attendance_record_id,
      businessId: ctx.businessIds[0],
      employeeId: ctx.employeeId,
      userId: ctx.userId,
    },
  })
  if (!record) return NextResponse.json({ error: 'Attendance record not found.' }, { status: 404 })

  const requestId = randomUUID()
  const attendanceDateYmd = record.attendanceDate.toISOString().slice(0, 10)

  const prepared = await prepareVerificationSelfieAssets({
    businessId: record.businessId,
    employeeId: ctx.employeeId,
    userId: ctx.userId,
    attendanceRecordId: record.id,
    attendanceDateYmd,
    imageDataUrl,
    requestId,
  })

  if (!prepared.ok) {
    logEvent('warn', 'attendance.selfie_verification.upload_failed', {
      requestId,
      employeeId: ctx.employeeId,
      businessId: record.businessId,
      attendanceRecordId: record.id,
      reason: prepared.code,
    })
    return NextResponse.json(
      { error: prepared.message, code: prepared.code },
      { status: 500 },
    )
  }

  const selfie = await prisma.attendanceSelfieVerification.create({
    data: {
      attendanceRecordId: record.id,
      businessId: record.businessId,
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      deviceKey: record.deviceKey,
      imageDataUrl: prepared.storageRef,
      contentType: prepared.contentType,
      sizeBytes: prepared.sizeBytes,
    },
  })

  await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: {
      verificationRequired: false,
      trustStatus: record.trustStatus === 'REQUIRES_VERIFICATION' ? 'WARNING' : record.trustStatus,
    },
  })

  logEvent('info', 'attendance.selfie_verification.submitted', {
    requestId,
    selfieId: selfie.id,
    employeeId: ctx.employeeId,
    businessId: record.businessId,
    attendanceRecordId: record.id,
    storageRef: prepared.storageRef,
  })

  return NextResponse.json({ ok: true, selfie: attendanceSelfieDto(selfie) })
}
