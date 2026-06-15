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
  officeHoursFor,
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
  logAttendanceCheckinValidationFailed,
} from '@/lib/attendance-checkin-log'
import { moneyDecimal } from '@/lib/payroll-wallet'
import type { PreparedCheckInFaceAssets } from '@/lib/attendance-photo-storage'
import {
  clearLiveFacePhotoForTelegram,
  notifyFaceVerifiedCheckIn,
  stageLiveFacePhotoForTelegram,
} from '@/lib/telegram-notification/face-checkin-notify'
import { notifyAttendancePenalty } from '@/lib/attendance'
import { errorMeta, logEvent } from '@/lib/logger'
import { isStaffOnLeaveByUserId } from '@/lib/staff-leave'

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
  faceAssets: PreparedCheckInFaceAssets
  deviceType?: string
}

export type AttendanceCheckInFacePayload = {
  buffer: Buffer
  contentType: string
}

export type AttendanceCheckInResult =
  | {
      ok: true
      duplicate: boolean
      record: ReturnType<typeof attendanceRecordDto>
      transactionMs: number
      penaltyAmount: number
    }
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
    return {
      ok: true,
      duplicate: true,
      record: attendanceRecordDto(existing),
      transactionMs: 0,
      penaltyAmount: Number(existing.penaltyAmount || 0),
    }
  }

  let { lateMinutes, penaltyAmount } = calculateLatePenalty(now, input.businessId)

  const staffLeave = await isStaffOnLeaveByUserId(input.userId, attendanceDateIso)
  if (staffLeave.onLeave) {
    penaltyAmount = 0
  }

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

  // GPS enforcement ONLY for ALMA_LIFESTYLE — other businesses keep old flow
  if (input.businessId === 'ALMA_LIFESTYLE') {
    if (!input.metadata.location?.latitude || !input.metadata.location?.longitude) {
      logAttendanceCheckinValidationFailed({
        ...logBase,
        reason: 'no_gps',
        latencyMs: Date.now() - started,
      })
      return {
        ok: false,
        code: 'location_required',
        message: 'Location access দিন — অফিসে থাকার proof ছাড়া attendance হবে না। Browser/App settings এ Location → Allow করুন।',
        status: 403,
      }
    }

    if (trust.suspiciousReasons.includes('LOCATION_MISMATCH')) {
      const distanceKm = trust.distanceFromOfficeM != null ? (trust.distanceFromOfficeM / 1000).toFixed(1) : '?'
      logAttendanceCheckinValidationFailed({
        ...logBase,
        reason: 'location_mismatch',
        latencyMs: Date.now() - started,
      })
      return {
        ok: false,
        code: 'location_mismatch',
        message: `আপনি অফিস থেকে ${distanceKm} কিমি দূরে আছেন। অফিসে এসে check-in করুন। GPS accuracy চেক করুন।`,
        status: 403,
      }
    }
  }

  logAttendanceCheckinTransactionStarted(logBase)

  const txStarted = Date.now()
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
            officeStartMinutes: officeHoursFor(input.businessId).startMinutes,
            officeEndMinutes: officeHoursFor(input.businessId).endMinutes,
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
            faceThumbDataUrl: input.faceAssets.thumbDataUrl,
            deviceInfo: deviceInfoFromRequest(input.req),
            sessionInfo: clientSessionInfo(sessionInfoFromRequest(input.req), input.metadata),
            ipHash: hashAttendanceIp(input.req),
          },
          include: RECORD_INCLUDE,
        })

        await tx.attendanceSelfieVerification.create({
          data: {
            attendanceRecordId: row.id,
            businessId: row.businessId,
            userId: row.userId,
            employeeId: row.employeeId,
            deviceKey: row.deviceKey,
            imageDataUrl: input.faceAssets.storageRef,
            contentType: input.faceAssets.contentType,
            sizeBytes: input.faceAssets.sizeBytes,
          },
        })

        if (penaltyAmount > 0) {
          row = (await applyLatePenaltyInTransaction(tx, row, input.userId)) as RecordWithIncludes
        }

        return tx.attendanceRecord.findUniqueOrThrow({
          where: { id: row.id },
          include: RECORD_INCLUDE,
        })
      },
      { maxWait: 8_000, timeout: 22_000 },
    )

    const transactionMs = Date.now() - txStarted
    logAttendanceCheckinTransactionCommitted({
      ...logBase,
      attendanceRecordId: record.id,
      latencyMs: Date.now() - started,
    })

    // CRITICAL: persist Telegram queue row BEFORE returning so the row survives
    // any post-response lambda termination on Vercel. The Telegram API delivery
    // itself stays in the cron / void post-response path.
    const enqueueResult = await persistAttendanceCheckInTelegramRow({
      record,
      faceAssets: input.faceAssets,
      logBase,
    })

    queueAttendanceCheckInSideEffects({
      record,
      faceAssets: input.faceAssets,
      faceBuffer: face.buffer,
      faceContentType: face.contentType,
      userId: input.userId,
      logBase,
      preEnqueuedTelegramIds: enqueueResult.queueIds,
    })

    return {
      ok: true,
      duplicate: false,
      record: attendanceRecordDto(record),
      transactionMs,
      penaltyAmount: Number(record.penaltyAmount || 0),
    }
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
        return {
          ok: true,
          duplicate: true,
          record: attendanceRecordDto(raced),
          transactionMs: Date.now() - txStarted,
          penaltyAmount: Number(raced.penaltyAmount || 0),
        }
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

/**
 * Persist the Telegram queue row for the face-verified check-in. Awaited inside
 * the request lifecycle — the DB insert is fast and must land before the lambda
 * can terminate. Telegram API delivery itself remains out of band.
 */
async function persistAttendanceCheckInTelegramRow(input: {
  record: AttendanceRecord
  faceAssets: PreparedCheckInFaceAssets
  logBase: {
    requestId: string
    userId: string
    employeeId: string
    businessId: string
    attendanceDate?: string
    deviceType?: string
  }
}): Promise<{ queueIds: string[] }> {
  const { record, faceAssets, logBase } = input
  try {
    const notify = await notifyFaceVerifiedCheckIn(record, {
      facePhotoBucket: faceAssets.storage.bucket,
      facePhotoPath: faceAssets.storage.objectPath,
    })
    if (!notify.ok) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'telegram_face',
        message: String(notify.skipped || 'notify_skipped'),
      })
      logEvent('warn', 'attendance.telegram_event_missing', {
        ...logBase,
        attendanceRecordId: record.id,
        reason: notify.skipped || 'notify_failed',
        phase: 'pre_response_enqueue',
      })
      return { queueIds: [] }
    }
    const queueIds = notify.queued && notify.queueIds?.length ? notify.queueIds : []
    if (queueIds.length) {
      logEvent('info', 'attendance.telegram.enqueued', {
        ...logBase,
        attendanceRecordId: record.id,
        queueIds,
        rowCount: queueIds.length,
        phase: 'pre_response_enqueue',
      })
      // Canonical Sentry event name for end-to-end check-in instrumentation.
      logEvent('info', 'attendance.checkin.telegram_queued', {
        ...logBase,
        attendanceRecordId: record.id,
        queueIds,
        rowCount: queueIds.length,
        phase: 'pre_response_enqueue',
      })
    }
    return { queueIds }
  } catch (err) {
    logAttendanceCheckinSideEffectFailed({
      ...logBase,
      sideEffect: 'telegram_face',
      message: (err as Error).message,
    })
    logEvent('error', 'attendance.telegram_event_missing', {
      ...logBase,
      attendanceRecordId: record.id,
      message: (err as Error).message,
      phase: 'pre_response_enqueue',
    })
    return { queueIds: [] }
  }
}

/**
 * Non-blocking post-response side effects — never affect HTTP response.
 * Triggers immediate-best-effort Telegram delivery for the already-persisted
 * queue rows, and fires absent-alert suppression + penalty notifications.
 */
export function queueAttendanceCheckInSideEffects(input: {
  record: AttendanceRecord
  faceAssets: PreparedCheckInFaceAssets
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
  preEnqueuedTelegramIds?: string[]
}) {
  const { record, faceBuffer, faceContentType, userId, logBase, preEnqueuedTelegramIds } = input

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

  if (preEnqueuedTelegramIds?.length) {
    void (async () => {
      stageLiveFacePhotoForTelegram(record.id, faceBuffer, faceContentType)
      try {
        const { processTelegramNotificationQueue } = await import(
          '@/lib/telegram-notification/queue'
        )
        await processTelegramNotificationQueue({
          ids: preEnqueuedTelegramIds,
          limit: preEnqueuedTelegramIds.length,
        })
      } catch (err) {
        logAttendanceCheckinSideEffectFailed({
          ...logBase,
          sideEffect: 'telegram_flush',
          message: (err as Error).message,
        })
      } finally {
        clearLiveFacePhotoForTelegram(record.id)
      }
    })()
  }

  void (async () => {
    try {
      const skipOwnerNotify =
        record.businessId === 'ALMA_LIFESTYLE' && record.lateMinutes > 0
      await notifyAttendancePenalty(record, userId, { skipOwnerNotify })
    } catch (err) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'penalty_notify',
        message: (err as Error).message,
      })
    }
  })()

  if (record.businessId === 'ALMA_LIFESTYLE' && record.lateMinutes > 0) {
    void (async () => {
      try {
        const leave = await isStaffOnLeaveByUserId(userId, logBase.attendanceDate)
        if (leave.onLeave) return
        const { coachLateCheckInFromRecord } = await import('@/lib/attendance-coaching')
        await coachLateCheckInFromRecord(record, userId)
      } catch (err) {
        logAttendanceCheckinSideEffectFailed({
          ...logBase,
          sideEffect: 'late_coaching',
          message: (err as Error).message,
        })
      }
    })()
  }

  // Auto-greeting: welcome + motivation + tracking message to staff on check-in
  void (async () => {
    try {
      const staff = await prisma.agentStaff.findFirst({
        where: { userId, active: true, businessId: record.businessId },
        select: { id: true, name: true, telegramChatId: true },
      })
      if (!staff?.telegramChatId) return

      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(record.checkInAt)
      const dedupeKey = `checkin_welcome:${staff.id}:${ymd}`

      const MOTIVATIONS = [
        'আজকের দিনটাকে সেরা করে তুলুন — প্রতিটি কাজ গুরুত্বপূর্ণ! 💪',
        'আল্লাহর রহমতে আজও একটি নতুন সুযোগ — সর্বোচ্চটা দিন! 🌟',
        'সফলতা আসে ছোট ছোট প্রচেষ্টা থেকে — আজ থেকেই শুরু! 🚀',
        'কঠিন পরিশ্রমের বিকল্প নেই — আজ আরও একটু এগিয়ে যান! 🎯',
        'প্রতিটি কাজই ইবাদত — সেরা মানের কাজ করুন! ✨',
      ]
      const motivation = MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)]

      const isLate = record.lateMinutes > 0
      const greeting = isLate
        ? `🏢 ${staff.name} ভাই, আপনি চেক-ইন করেছেন (${record.lateMinutes} মিনিট দেরি)।`
        : `🌅 সুপ্রভাত ${staff.name} ভাই! আজ সময়মতো চেক-ইন — দারুণ! 👏`

      const message = `${greeting}\n\n💡 ${motivation}\n\n📊 আজ আপনার সব কাজ আমি ট্র্যাক করছি — শেষ হলে ✅ Done বাটন চাপুন।`

      const { enqueueTelegramNotification } = await import(
        '@/lib/telegram-notification/queue'
      )
      await enqueueTelegramNotification({
        businessId: record.businessId,
        eventType: 'ATTENDANCE_FACE_VERIFIED_CHECK_IN',
        message,
        chatIds: [staff.telegramChatId],
        dedupeKey,
        metadata: { force: true, staffWelcome: true, staffId: staff.id },
      })
    } catch (err) {
      logAttendanceCheckinSideEffectFailed({
        ...logBase,
        sideEffect: 'checkin_welcome',
        message: (err as Error).message,
      })
    }
  })()
}
