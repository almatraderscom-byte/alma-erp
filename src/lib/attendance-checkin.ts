import type { NextRequest } from 'next/server'
import type { AttendanceRecord, AttendanceSelfieVerification, AttendanceWaiverRequest } from '@prisma/client'
import { Prisma as PrismaNs } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  attendanceDateFor,
  attendanceRecordDto,
  attendanceSourceRef,
  assessAttendanceTrust,
  calculateLatePenalty,
  clientSessionInfo,
  deviceKeyFor,
  deviceInfoFromRequest,
  hashAttendanceIp,
  LATE_PENALTY_SOURCE,
  normalizeClientMetadata,
  OFFICE_END_MINUTES,
  OFFICE_START_MINUTES,
  sessionInfoFromRequest,
  type AttendanceClientMetadata,
} from '@/lib/attendance'
import { suppressStaleAbsentAlertsForCheckIn } from '@/lib/attendance-absent-safety'
import {
  logAttendanceCheckinDuplicateBlocked,
  logAttendanceCheckinSideEffectFailed,
  logAttendanceCheckinTransactionCommitted,
  logAttendanceCheckinTransactionFailed,
  logAttendanceCheckinTransactionStarted,
} from '@/lib/attendance-checkin-log'
import { moneyDecimal } from '@/lib/payroll-wallet'
import {
  clearLiveFacePhotoForTelegram,
  notifyFaceVerifiedCheckIn,
  stageLiveFacePhotoForTelegram,
} from '@/lib/telegram-notification/face-checkin-notify'
import { notifyAttendancePenalty } from '@/lib/attendance'
import { errorMeta } from '@/lib/logger'

const RECORD_INCLUDE = {
  waiverRequests: true,
  selfieVerifications: true,
} as const

type RecordWithIncludes = AttendanceRecord & {
  waiverRequests: AttendanceWaiverRequest[]
  selfieVerifications: AttendanceSelfieVerification[]
}

export type AttendanceCheckInInput = {
  requestId: string
  req: NextRequest
  businessId: string
  userId: string
  employeeId: string
  metadata: AttendanceClientMetadata
  faceThumb: string | null
  deviceType?: string
}

export type AttendanceCheckInFacePayload = {
  buffer: Buffer
  contentType: string
}

export type AttendanceCheckInResult =
  | { ok: true; duplicate: boolean; record: ReturnType<typeof attendanceRecordDto> }
  | { ok: false; code: string; message: string; status: number }

async function findTodayRecord(businessId: string, employeeId: string, attendanceDate: Date) {
  return prisma.attendanceRecord.findUnique({
    where: {
      businessId_employeeId_attendanceDate: { businessId, employeeId, attendanceDate },
    },
    include: RECORD_INCLUDE,
  })
}

async function applyLatePenaltyInTransaction(
  tx: PrismaNs.TransactionClient,
  record: AttendanceRecord,
  actorUserId: string,
) {
  const amount = Number(record.penaltyAmount || 0)
  if (!Number.isFinite(amount) || amount <= 0 || record.penaltyLedgerEntryId) {
    return record
  }

  const sourceRef = attendanceSourceRef(record.businessId, record.employeeId, record.attendanceDate)
  try {
    const entry = await tx.employeeLedgerEntry.create({
      data: {
        employeeId: record.employeeId,
        businessId: record.businessId,
        date: record.attendanceDate,
        type: 'PENALTY',
        amount: moneyDecimal(amount),
        note: `Late attendance penalty · ${record.attendanceDate.toISOString().slice(0, 10)}`,
        createdById: actorUserId,
        approvedById: actorUserId,
        source: LATE_PENALTY_SOURCE,
        sourceRef,
      },
    })
    return tx.attendanceRecord.update({
      where: { id: record.id },
      data: { penaltyLedgerEntryId: entry.id },
      include: RECORD_INCLUDE,
    })
  } catch (e) {
    if (e instanceof PrismaNs.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await tx.employeeLedgerEntry.findUnique({
        where: { source_sourceRef: { source: LATE_PENALTY_SOURCE, sourceRef } },
      })
      if (existing) {
        return tx.attendanceRecord.update({
          where: { id: record.id },
          data: { penaltyLedgerEntryId: existing.id },
          include: RECORD_INCLUDE,
        })
      }
    }
    throw e
  }
}

export async function commitAttendanceCheckIn(
  input: AttendanceCheckInInput,
  face: AttendanceCheckInFacePayload,
): Promise<AttendanceCheckInResult> {
  const started = Date.now()
  const now = new Date()
  const attendanceDate = attendanceDateFor(now)
  const attendanceDateIso = attendanceDate.toISOString().slice(0, 10)
  const logBase = {
    requestId: input.requestId,
    userId: input.userId,
    employeeId: input.employeeId,
    businessId: input.businessId,
    attendanceDate: attendanceDateIso,
    deviceType: input.deviceType,
  }

  const existing = await findTodayRecord(input.businessId, input.employeeId, attendanceDate)
  if (existing?.checkInAt) {
    logAttendanceCheckinDuplicateBlocked({
      ...logBase,
      attendanceRecordId: existing.id,
      latencyMs: Date.now() - started,
    })
    void suppressStaleAbsentAlertsForCheckIn(existing).catch(err => {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'suppress_absent',
        message: (err as Error).message,
      })
    })
    return { ok: true, duplicate: true, record: attendanceRecordDto(existing) }
  }

  const { lateMinutes, penaltyAmount } = calculateLatePenalty(now)
  const deviceKey = deviceKeyFor(input.req, input.metadata)
  const trust = await assessAttendanceTrust({
    businessId: input.businessId,
    employeeId: input.employeeId,
    deviceKey,
    location: input.metadata.location,
  })
  const latitude = input.metadata.location?.latitude
  const longitude = input.metadata.location?.longitude
  const accuracy = input.metadata.location?.accuracy
  const needsAdminSelfie = trust.suspiciousReasons.includes('ADMIN_REQUEST')

  logAttendanceCheckinTransactionStarted(logBase)

  try {
    const record = await prisma.$transaction(
      async tx => {
        let row = await tx.attendanceRecord.create({
          data: {
            businessId: input.businessId,
            userId: input.userId,
            employeeId: input.employeeId,
            attendanceDate,
            status: penaltyAmount > 0 ? 'LATE' : 'PRESENT',
            officeStartMinutes: OFFICE_START_MINUTES,
            officeEndMinutes: OFFICE_END_MINUTES,
            checkInAt: now,
            lateMinutes,
            penaltyAmount: new PrismaNs.Decimal(penaltyAmount.toFixed(2)),
            browserFingerprint: input.metadata.browserFingerprint,
            deviceKey,
            sessionId: input.metadata.sessionId,
            latitude: latitude == null ? null : new PrismaNs.Decimal(latitude.toFixed(7)),
            longitude: longitude == null ? null : new PrismaNs.Decimal(longitude.toFixed(7)),
            locationAccuracyM: accuracy == null ? null : Math.round(accuracy),
            distanceFromOfficeM: trust.distanceFromOfficeM,
            trustStatus: trust.trustStatus,
            suspiciousReasons: trust.suspiciousReasons,
            verificationRequired: needsAdminSelfie,
            faceVerified: true,
            faceVerifiedAt: now,
            faceThumbDataUrl: input.faceThumb,
            deviceInfo: deviceInfoFromRequest(input.req),
            sessionInfo: clientSessionInfo(sessionInfoFromRequest(input.req), input.metadata),
            ipHash: hashAttendanceIp(input.req),
          },
          include: RECORD_INCLUDE,
        })

        if (penaltyAmount > 0) {
          row = (await applyLatePenaltyInTransaction(tx, row, input.userId)) as RecordWithIncludes
        }
        return row
      },
      { maxWait: 8_000, timeout: 22_000 },
    )

    logAttendanceCheckinTransactionCommitted({
      ...logBase,
      attendanceRecordId: record.id,
      latencyMs: Date.now() - started,
    })

    queueAttendanceCheckInSideEffects({
      record,
      faceBuffer: face.buffer,
      faceContentType: face.contentType,
      userId: input.userId,
      logBase,
    })

    return { ok: true, duplicate: false, record: attendanceRecordDto(record) }
  } catch (e) {
    if (e instanceof PrismaNs.PrismaClientKnownRequestError && e.code === 'P2002') {
      const raced = await findTodayRecord(input.businessId, input.employeeId, attendanceDate)
      if (raced?.checkInAt) {
        logAttendanceCheckinDuplicateBlocked({
          ...logBase,
          attendanceRecordId: raced.id,
          reason: 'race_duplicate',
          latencyMs: Date.now() - started,
        })
        return { ok: true, duplicate: true, record: attendanceRecordDto(raced) }
      }
      logAttendanceCheckinTransactionFailed({
        ...logBase,
        ...errorMeta(e),
        reason: 'duplicate_without_record',
        latencyMs: Date.now() - started,
      })
      return {
        ok: false,
        code: 'duplicate_conflict',
        message: 'Check-in already exists but could not be loaded. Refresh and try again.',
        status: 409,
      }
    }

    logAttendanceCheckinTransactionFailed({
      ...logBase,
      ...errorMeta(e),
      latencyMs: Date.now() - started,
    })
    throw e
  }
}

/** Non-blocking side effects — must never affect HTTP response. */
export function queueAttendanceCheckInSideEffects(input: {
  record: AttendanceRecord
  faceBuffer: Buffer
  faceContentType: string
  userId: string
  logBase: {
    requestId: string
    userId: string
    employeeId: string
    businessId: string
    attendanceDate?: string
    deviceType?: string
  }
}) {
  const { record, faceBuffer, faceContentType, userId, logBase } = input

  void (async () => {
    try {
      await suppressStaleAbsentAlertsForCheckIn(record)
    } catch (err) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'suppress_absent',
        message: (err as Error).message,
      })
    }
  })()

  void (async () => {
    stageLiveFacePhotoForTelegram(record.id, faceBuffer, faceContentType)
    try {
      await notifyFaceVerifiedCheckIn(record)
    } catch (err) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'telegram_face',
        message: (err as Error).message,
      })
    } finally {
      clearLiveFacePhotoForTelegram(record.id)
    }
  })()

  void (async () => {
    try {
      await notifyAttendancePenalty(record, userId)
    } catch (err) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'penalty_notify',
        message: (err as Error).message,
      })
    }
  })()
}
