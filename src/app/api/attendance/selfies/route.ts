import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceSelfieDto } from '@/lib/attendance'

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
  const contentType = String(body.content_type || 'image/jpeg').slice(0, 80)
  const estimatedBytes = Math.ceil((imageDataUrl.length * 3) / 4)
  if (!body.attendance_record_id || !imageDataUrl.startsWith('data:image/')) {
    return NextResponse.json({ error: 'Attendance record and selfie image are required.' }, { status: 400 })
  }
  if (estimatedBytes > MAX_SELFIE_BYTES) {
    return NextResponse.json({ error: 'Selfie image is too large. Please retake it.' }, { status: 413 })
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

  const selfie = await prisma.attendanceSelfieVerification.create({
    data: {
      attendanceRecordId: record.id,
      businessId: record.businessId,
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      deviceKey: record.deviceKey,
      imageDataUrl,
      contentType,
      sizeBytes: estimatedBytes,
    },
  })

  await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: {
      verificationRequired: false,
      trustStatus: record.trustStatus === 'REQUIRES_VERIFICATION' ? 'WARNING' : record.trustStatus,
    },
  })

  return NextResponse.json({ ok: true, selfie: attendanceSelfieDto(selfie) })
}
