import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import {
  attendanceDateFor,
  assessAttendanceTrust,
  calculateLatePenalty,
  clientSessionInfo,
  deviceKeyFor,
  deviceInfoFromRequest,
  hashAttendanceIp,
  normalizeClientMetadata,
  notifyAttendancePenalty,
  OFFICE_END_MINUTES,
  OFFICE_START_MINUTES,
  postAttendancePenalty,
  sessionInfoFromRequest,
  attendanceRecordDto,
} from '@/lib/attendance'
import {
  buildFaceThumbDataUrl,
  MAX_THUMB_DATA_URL_CHARS,
  normalizeFaceImageForCheckIn,
} from '@/lib/attendance-face-image'
import {
  clearLiveFacePhotoForTelegram,
  notifyFaceVerifiedCheckIn,
  stageLiveFacePhotoForTelegram,
} from '@/lib/telegram-notification/face-checkin-notify'
import { suppressStaleAbsentAlertsForCheckIn } from '@/lib/attendance-absent-safety'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    metadata?: unknown
    face_verification?: { image_data_url?: string; thumb_data_url?: string }
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.isSystemOwner) {
    return NextResponse.json({ error: 'System owner accounts do not use employee attendance.' }, { status: 403 })
  }
  if (!ctx.employeeId) {
    return NextResponse.json(
      {
        error:
          'Your account is not linked to an HR employee ID. Ask admin to set employee ID (or Trading HR profile) in Users.',
      },
      { status: 400 },
    )
  }

  const faceRaw = String(body.face_verification?.image_data_url || '').trim()
  if (!faceRaw) {
    return NextResponse.json(
      { error: 'Face verification photo is required. Use the front camera before starting work.' },
      { status: 400 },
    )
  }
  const parsedFace = await normalizeFaceImageForCheckIn(faceRaw)
  if (!parsedFace) {
    return NextResponse.json(
      { error: 'Could not process face photo. Retake in good light with the front camera (JPEG/PNG/WebP).' },
      { status: 400 },
    )
  }

  let faceThumb =
    typeof body.face_verification?.thumb_data_url === 'string'
    && body.face_verification.thumb_data_url.length <= MAX_THUMB_DATA_URL_CHARS
      ? body.face_verification.thumb_data_url
      : null
  if (!faceThumb) {
    faceThumb = await buildFaceThumbDataUrl(parsedFace.buffer)
  }

  const now = new Date()
  const attendanceDate = attendanceDateFor(now)
  const { lateMinutes, penaltyAmount } = calculateLatePenalty(now)
  const metadata = normalizeClientMetadata(body.metadata)
  const deviceKey = deviceKeyFor(req, metadata)
  const trust = await assessAttendanceTrust({
    businessId: ctx.businessIds[0],
    employeeId: ctx.employeeId,
    deviceKey,
    location: metadata.location,
  })
  const latitude = metadata.location?.latitude
  const longitude = metadata.location?.longitude
  const accuracy = metadata.location?.accuracy

  const needsAdminSelfie = trust.suspiciousReasons.includes('ADMIN_REQUEST')

  try {
    let record = await prisma.attendanceRecord.create({
      data: {
        businessId: ctx.businessIds[0],
        userId: ctx.userId,
        employeeId: ctx.employeeId,
        attendanceDate,
        status: penaltyAmount > 0 ? 'LATE' : 'PRESENT',
        officeStartMinutes: OFFICE_START_MINUTES,
        officeEndMinutes: OFFICE_END_MINUTES,
        checkInAt: now,
        lateMinutes,
        penaltyAmount: new Prisma.Decimal(penaltyAmount.toFixed(2)),
        browserFingerprint: metadata.browserFingerprint,
        deviceKey,
        sessionId: metadata.sessionId,
        latitude: latitude == null ? null : new Prisma.Decimal(latitude.toFixed(7)),
        longitude: longitude == null ? null : new Prisma.Decimal(longitude.toFixed(7)),
        locationAccuracyM: accuracy == null ? null : Math.round(accuracy),
        distanceFromOfficeM: trust.distanceFromOfficeM,
        trustStatus: trust.trustStatus,
        suspiciousReasons: trust.suspiciousReasons,
        verificationRequired: needsAdminSelfie,
        faceVerified: true,
        faceVerifiedAt: now,
        faceThumbDataUrl: faceThumb,
        deviceInfo: deviceInfoFromRequest(req),
        sessionInfo: clientSessionInfo(sessionInfoFromRequest(req), metadata),
        ipHash: hashAttendanceIp(req),
      },
      include: { waiverRequests: true, selfieVerifications: true },
    })

    if (penaltyAmount > 0) {
      await postAttendancePenalty(record, ctx.userId)
      await notifyAttendancePenalty(record, ctx.userId)
      record = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: record.id },
        include: { waiverRequests: true, selfieVerifications: true },
      })
    }

    await suppressStaleAbsentAlertsForCheckIn(record)

    stageLiveFacePhotoForTelegram(record.id, parsedFace.buffer, parsedFace.contentType)
    try {
      await notifyFaceVerifiedCheckIn(record)
    } catch (err) {
      console.error('[attendance-check-in] telegram face notify', (err as Error).message)
    } finally {
      clearLiveFacePhotoForTelegram(record.id)
    }

    const committedAt = new Date()
    logEvent('info', 'attendance.checkin.success', {
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      businessId: ctx.businessIds[0],
      attendanceRecordId: record.id,
      checkInAt: record.checkInAt.toISOString(),
      dbCommittedAt: committedAt.toISOString(),
      durationMs: Date.now() - started,
    })
    logEvent('info', 'attendance.check_in.ok', {
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      businessId: ctx.businessIds[0],
      attendanceRecordId: record.id,
      durationMs: Date.now() - started,
    })
    return NextResponse.json({ ok: true, record: attendanceRecordDto(record) })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.attendanceRecord.findUnique({
        where: {
          businessId_employeeId_attendanceDate: {
            businessId: ctx.businessIds[0],
            employeeId: ctx.employeeId,
            attendanceDate,
          },
        },
        include: { waiverRequests: true, selfieVerifications: true },
      })
      if (existing) {
        await suppressStaleAbsentAlertsForCheckIn(existing)
        logEvent('info', 'attendance.checkin.success', {
          userId: ctx.userId,
          employeeId: ctx.employeeId,
          businessId: ctx.businessIds[0],
          attendanceRecordId: existing.id,
          duplicate: true,
          checkInAt: existing.checkInAt.toISOString(),
        })
      }
      return NextResponse.json({
        ok: true,
        duplicate: true,
        record: existing ? attendanceRecordDto(existing) : null,
      })
    }
    throw e
  }
  } catch (e) {
    logEvent('error', 'attendance.check_in.failed', { ...errorMeta(e), durationMs: Date.now() - started })
    const msg = (e as Error).message || ''
    if (msg.includes('faceVerified') || msg.includes('faceThumbDataUrl') || msg.includes('does not exist')) {
      return NextResponse.json(
        { error: 'Attendance face verification is not deployed on the database yet. Contact admin to run migrations.' },
        { status: 503 },
      )
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json({ error: 'Could not save attendance. Please retry.' }, { status: 500 })
    }
    return NextResponse.json({ error: 'Check-in failed. Check network and retry.' }, { status: 500 })
  }
}
