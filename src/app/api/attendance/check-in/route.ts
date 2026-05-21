import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { apiDataSuccess, apiFailure } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { classifyAttendanceDbError } from '@/lib/core/safe-attendance'
import { requireWalletContext } from '@/lib/core/safe-route-helpers'
import { normalizeClientMetadata } from '@/lib/attendance'
import {
  buildFaceThumbDataUrl,
  MAX_THUMB_DATA_URL_CHARS,
  normalizeFaceImageForCheckIn,
} from '@/lib/attendance-face-image'
import { commitAttendanceCheckIn } from '@/lib/attendance-checkin'
import {
  logAttendanceCheckinRequested,
  logAttendanceCheckinResponseSent,
  logAttendanceCheckinValidationFailed,
} from '@/lib/attendance-checkin-log'
import {
  logAttendanceHealthSummary,
  recordAttendanceCheckinMetric,
} from '@/lib/attendance-checkin-observability'
import { attendanceDateFor } from '@/lib/attendance'
import { prisma } from '@/lib/prisma'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function deviceTypeFromRequest(req: NextRequest) {
  const ua = (req.headers.get('user-agent') || '').toLowerCase()
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile'
  if (ua.includes('ipad') || ua.includes('tablet')) return 'tablet'
  return 'desktop'
}

export const POST = withApiRoute('attendance.check_in', async (req: NextRequest) => {
  const started = Date.now()
  const requestId = req.headers.get('x-request-id')?.trim() || randomUUID()
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    metadata?: unknown
    face_verification?: { image_data_url?: string; thumb_data_url?: string }
    request_id?: string
  }
  const clientRequestId = String(body.request_id || '').trim() || requestId

  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) {
    logAttendanceCheckinValidationFailed({
      requestId: clientRequestId,
      reason: 'auth_failed',
      latencyMs: Date.now() - started,
      deviceType: deviceTypeFromRequest(req),
    })
    return auth.response
  }
  const ctx = auth.ctx

  const logBase = {
    requestId: clientRequestId,
    userId: ctx.userId,
    employeeId: ctx.employeeId ?? undefined,
    businessId: ctx.businessIds[0],
    deviceType: deviceTypeFromRequest(req),
  }

  logAttendanceCheckinRequested(logBase)

  if (ctx.isSystemOwner) {
    logAttendanceCheckinValidationFailed({ ...logBase, reason: 'system_owner', latencyMs: Date.now() - started })
    return apiFailure('forbidden', 'System owner accounts do not use employee attendance.', { status: 403 })
  }
  if (!ctx.employeeId) {
    logAttendanceCheckinValidationFailed({ ...logBase, reason: 'missing_employee_id', latencyMs: Date.now() - started })
    return apiFailure(
      'invalid_request',
      'Your account is not linked to an HR employee ID. Ask admin to set employee ID (or Trading HR profile) in Users.',
      { status: 400 },
    )
  }

  const faceRaw = String(body.face_verification?.image_data_url || '').trim()
  if (!faceRaw) {
    logAttendanceCheckinValidationFailed({ ...logBase, reason: 'missing_face', latencyMs: Date.now() - started })
    return apiFailure('invalid_request', 'Face verification photo is required. Use the front camera before starting work.', { status: 400 })
  }

  const parsedFace = await normalizeFaceImageForCheckIn(faceRaw)
  if (!parsedFace) {
    logAttendanceCheckinValidationFailed({ ...logBase, reason: 'invalid_face', latencyMs: Date.now() - started })
    return apiFailure('invalid_request', 'Could not process face photo. Retake in good light with the front camera (JPEG/PNG/WebP).', { status: 400 })
  }

  let faceThumb =
    typeof body.face_verification?.thumb_data_url === 'string'
    && body.face_verification.thumb_data_url.length <= MAX_THUMB_DATA_URL_CHARS
      ? body.face_verification.thumb_data_url
      : null
  if (!faceThumb) {
    faceThumb = await buildFaceThumbDataUrl(parsedFace.buffer)
  }

  const metadata = normalizeClientMetadata(body.metadata)

  try {
    const result = await commitAttendanceCheckIn(
      {
        requestId: clientRequestId,
        req,
        businessId: ctx.businessIds[0],
        userId: ctx.userId,
        employeeId: ctx.employeeId,
        metadata,
        faceThumb,
        deviceType: logBase.deviceType,
      },
      { buffer: parsedFace.buffer, contentType: parsedFace.contentType },
    )

    if (!result.ok) {
      logAttendanceCheckinValidationFailed({
        ...logBase,
        reason: result.code,
        message: result.message,
        latencyMs: Date.now() - started,
      })
      return apiFailure(result.code, result.message, { status: result.status })
    }

    const latencyMs = Date.now() - started
    const attendanceDate = attendanceDateFor().toISOString().slice(0, 10)
    const dayStart = attendanceDateFor()
    const dayEnd = new Date(dayStart.getTime() + 86_400_000)

    let todayCheckIns = 0
    try {
      todayCheckIns = await prisma.attendanceRecord.count({
        where: {
          businessId: ctx.businessIds[0],
          attendanceDate: { gte: dayStart, lt: dayEnd },
        },
      })
    } catch {
      /* observability only */
    }

    const metric = {
      requestId: clientRequestId,
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      businessId: ctx.businessIds[0],
      attendanceDate,
      deviceType: logBase.deviceType,
      outcome: result.duplicate ? ('duplicate' as const) : ('success' as const),
      latencyMs,
      transactionMs: result.transactionMs,
      duplicate: result.duplicate,
      mobile: logBase.deviceType === 'mobile',
      penaltyAmount: result.penaltyAmount,
      attendanceRecordId: result.record.id,
    }
    recordAttendanceCheckinMetric(metric)
    logAttendanceHealthSummary({ ...metric, todayCheckIns })

    logAttendanceCheckinResponseSent({
      ...logBase,
      attendanceRecordId: result.record.id,
      duplicate: result.duplicate,
      latencyMs,
    })
    logEvent('info', 'attendance.checkin.success', {
      ...logBase,
      attendanceRecordId: result.record.id,
      duplicate: result.duplicate,
      durationMs: latencyMs,
      transactionMs: result.transactionMs,
    })

    return apiDataSuccess({
      requestId: clientRequestId,
      duplicate: result.duplicate,
      record: result.record,
    })
  } catch (e) {
    logEvent('error', 'attendance.checkin.transaction_failed', {
      ...logBase,
      ...errorMeta(e),
      durationMs: Date.now() - started,
    })
    throw e
  }
}, { classifyError: classifyAttendanceDbError })
