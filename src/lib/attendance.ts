import crypto from 'crypto'
import type { AttendanceRecord, AttendanceSelfieVerification, AttendanceWaiverRequest } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { dateBn, toBnDigits } from '@/lib/wallet-labels'

export const OFFICE_START_MINUTES = 9 * 60 // 540 = 9:00 AM
export const OFFICE_END_MINUTES = 21 * 60 // 1260 = 9:00 PM
export const ATTENDANCE_TIMEZONE = 'Asia/Dhaka'
export const LATE_PENALTY_SOURCE = 'attendance_late_penalty'
export const LATE_PENALTY_REVERSAL_SOURCE = 'attendance_late_penalty_reversal'
export const DEFAULT_OFFICE_RADIUS_M = 500
export const LOCATION_CHANGE_ALERT_M = 20_000

const BUSINESS_OFFICE_HOURS: Record<string, { start: number; end: number }> = {
  ALMA_LIFESTYLE: { start: 9 * 60 + 30, end: 20 * 60 }, // 9:30 AM – 8:00 PM
}

export function officeHoursFor(businessId: string) {
  const custom = BUSINESS_OFFICE_HOURS[businessId]
  return {
    startMinutes: custom?.start ?? OFFICE_START_MINUTES,
    endMinutes: custom?.end ?? OFFICE_END_MINUTES,
  }
}

export type AttendanceClientMetadata = {
  browserFingerprint?: string | null
  sessionId?: string | null
  timezone?: string | null
  language?: string | null
  platform?: string | null
  screen?: string | null
  location?: {
    latitude?: number | null
    longitude?: number | null
    accuracy?: number | null
  } | null
}

const LOCAL_PART_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATTENDANCE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

type LocalParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export type AttendanceRecordDto = ReturnType<typeof attendanceRecordDto>
export type AttendanceWaiverDto = ReturnType<typeof attendanceWaiverDto>
export type AttendanceSelfieDto = ReturnType<typeof attendanceSelfieDto>

export function localParts(date = new Date()): LocalParts {
  const parts = Object.fromEntries(LOCAL_PART_FORMATTER.formatToParts(date).map(p => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  }
}

export function attendanceDateFor(date = new Date()) {
  const p = localParts(date)
  return new Date(Date.UTC(p.year, p.month - 1, p.day))
}

export function localMinutesFor(date = new Date()) {
  const p = localParts(date)
  return p.hour * 60 + p.minute
}

export function calculateLatePenalty(checkInAt = new Date(), businessId?: string) {
  const { startMinutes } = officeHoursFor(businessId || '')
  const checkInMinutes = localMinutesFor(checkInAt)
  const lateMinutes = Math.max(0, checkInMinutes - startMinutes)
  let penaltyAmount = 0

  if (lateMinutes <= 0) {
    // On time — no penalty
  } else if (checkInMinutes < 10 * 60) {
    // Late but before 10:00 AM → ৳50
    penaltyAmount = 50
  } else {
    // 10:00+ → ৳100 per hour slot past 9:00
    penaltyAmount = Math.max(100, (Math.floor(checkInMinutes / 60) - 9) * 100)
  }

  return { lateMinutes, penaltyAmount }
}

/** Count LATE check-ins for an employee in the last 7 calendar days. */
export async function countRecentLateDays(employeeId: string, businessId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 86_400_000)
  try {
    return await prisma.attendanceRecord.count({
      where: {
        employeeId,
        businessId,
        lateMinutes: { gt: 0 },
        attendanceDate: { gte: since },
      },
    })
  } catch {
    return 0
  }
}

export function calculateEarlyCheckoutPenalty(checkOutAt = new Date(), businessId?: string) {
  const { endMinutes } = officeHoursFor(businessId || '')
  const checkOutMinutes = localMinutesFor(checkOutAt)
  const earlyMinutes = Math.max(0, endMinutes - checkOutMinutes)
  let earlyPenaltyAmount = 0

  if (earlyMinutes <= 0) {
    // On time or after — no penalty
  } else if (earlyMinutes <= 60) {
    // Left 1–60 min early → ৳50
    earlyPenaltyAmount = 50
  } else {
    // Left >1 hour early → ৳100 per hour
    const hoursEarly = Math.floor(earlyMinutes / 60)
    earlyPenaltyAmount = Math.max(100, hoursEarly * 100)
  }

  return { earlyMinutes, earlyPenaltyAmount }
}

export const EARLY_LEAVE_PENALTY_SOURCE = 'attendance_early_leave_penalty'

export function earlyLeaveSourceRef(businessId: string, employeeId: string, attendanceDate: Date) {
  return `attendance-early:${businessId}:${employeeId}:${attendanceDate.toISOString().slice(0, 10)}`
}

export function attendanceSourceRef(businessId: string, employeeId: string, attendanceDate: Date) {
  return `attendance-late:${businessId}:${employeeId}:${attendanceDate.toISOString().slice(0, 10)}`
}

export function attendanceReversalSourceRef(waiverId: string) {
  return `attendance-late-reversal:${waiverId}`
}

/** Bangla ledger note for a late check-in fine: date + how late (the "why"). */
export function latePenaltyNoteBn(attendanceDate: Date, lateMinutes: number) {
  const day = dateBn(attendanceDate)
  return lateMinutes > 0
    ? `দেরিতে চেক-ইনের জরিমানা — ${day} · ${toBnDigits(lateMinutes)} মিনিট দেরি`
    : `দেরিতে চেক-ইনের জরিমানা — ${day}`
}

/** Bangla ledger note for an approved-appeal refund, naming the original fine. */
export function penaltyRefundNoteBn(fineDate: Date | null | undefined) {
  return fineDate
    ? `জরিমানা ফেরত — আপিল মঞ্জুর · ${dateBn(fineDate)}-এর জরিমানার সমন্বয়`
    : 'জরিমানা ফেরত — আপিল মঞ্জুর'
}

export function hashAttendanceIp(req: NextRequest) {
  const raw = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.ip || ''
  if (!raw) return null
  const salt = process.env.ATTENDANCE_IP_HASH_SALT || process.env.NEXTAUTH_SECRET || 'alma-attendance'
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex').slice(0, 64)
}

export function deviceInfoFromRequest(req: NextRequest) {
  return (req.headers.get('user-agent') || '').slice(0, 500) || null
}

export function sessionInfoFromRequest(req: NextRequest) {
  const sessionBits = {
    platform: req.headers.get('sec-ch-ua-platform') || null,
    mobile: req.headers.get('sec-ch-ua-mobile') || null,
    acceptLanguage: req.headers.get('accept-language')?.slice(0, 120) || null,
  }
  return JSON.stringify(sessionBits)
}

export function normalizeClientMetadata(input: unknown): AttendanceClientMetadata {
  const raw = (input && typeof input === 'object' ? input : {}) as AttendanceClientMetadata
  const loc = raw.location && typeof raw.location === 'object' ? raw.location : null
  return {
    browserFingerprint: String(raw.browserFingerprint || '').slice(0, 500) || null,
    sessionId: String(raw.sessionId || '').slice(0, 120) || null,
    timezone: String(raw.timezone || '').slice(0, 80) || null,
    language: String(raw.language || '').slice(0, 80) || null,
    platform: String(raw.platform || '').slice(0, 120) || null,
    screen: String(raw.screen || '').slice(0, 80) || null,
    location: loc
      ? {
          latitude: finiteLocationNumber(loc.latitude, -90, 90),
          longitude: finiteLocationNumber(loc.longitude, -180, 180),
          accuracy: finiteLocationNumber(loc.accuracy, 0, 100_000),
        }
      : null,
  }
}

function finiteLocationNumber(value: unknown, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

export function clientSessionInfo(base: string | null, meta: AttendanceClientMetadata) {
  const fromRequest = safeJson(base)
  return JSON.stringify({
    ...fromRequest,
    timezone: meta.timezone || null,
    language: meta.language || null,
    platform: meta.platform || null,
    screen: meta.screen || null,
  }).slice(0, 2000)
}

function safeJson(value: string | null) {
  if (!value) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function deviceKeyFor(req: NextRequest, meta: AttendanceClientMetadata) {
  const raw = [
    meta.browserFingerprint || '',
    req.headers.get('user-agent') || '',
    meta.platform || '',
    meta.screen || '',
  ].join('|')
  if (!raw.replace(/\|/g, '').trim()) return null
  const salt = process.env.ATTENDANCE_DEVICE_HASH_SALT || process.env.NEXTAUTH_SECRET || 'alma-attendance-device'
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex').slice(0, 64)
}

export function officeLocationFor(businessId: string) {
  const key = businessId.toUpperCase()
  const lat = Number(process.env[`OFFICE_${key}_LAT`] || process.env.OFFICE_LAT || '')
  const lng = Number(process.env[`OFFICE_${key}_LNG`] || process.env.OFFICE_LNG || '')
  const radius = Number(process.env[`OFFICE_${key}_RADIUS_M`] || process.env.OFFICE_RADIUS_M || DEFAULT_OFFICE_RADIUS_M)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { latitude: lat, longitude: lng, radiusM: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_OFFICE_RADIUS_M }
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = 6_371_000
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return Math.round(2 * r * Math.asin(Math.sqrt(h)))
}

function toRad(n: number) {
  return (n * Math.PI) / 180
}

export async function assessAttendanceTrust(input: {
  businessId: string
  employeeId: string
  deviceKey: string | null
  location: AttendanceClientMetadata['location']
}) {
  const reasons: string[] = []
  const now = new Date()
  // 14-day lookback is sufficient for NEW_DEVICE / FREQUENT_DEVICE_CHANGES /
  // LOCATION_CHANGED heuristics and halves the row fetch per check-in.
  const since = new Date(now.getTime() - 14 * 86_400_000)
  const recent = await prisma.attendanceRecord.findMany({
    where: {
      businessId: input.businessId,
      employeeId: input.employeeId,
      attendanceDate: { gte: since },
    },
    select: { deviceKey: true, latitude: true, longitude: true },
    orderBy: { attendanceDate: 'desc' },
    take: 14,
  })

  if (input.deviceKey) {
    const knownDevice = recent.some(row => row.deviceKey === input.deviceKey)
    if (recent.length > 0 && !knownDevice) reasons.push('NEW_DEVICE')
    const uniqueDevices = new Set(recent.map(row => row.deviceKey).filter(Boolean))
    if (!uniqueDevices.has(input.deviceKey)) uniqueDevices.add(input.deviceKey)
    if (uniqueDevices.size >= 4) reasons.push('FREQUENT_DEVICE_CHANGES')
  }

  let distanceFromOfficeM: number | null = null
  const latitude = input.location?.latitude
  const longitude = input.location?.longitude
  if (latitude != null && longitude != null) {
    const office = officeLocationFor(input.businessId)
    if (office) {
      distanceFromOfficeM = distanceMeters({ latitude, longitude }, office)
      if (distanceFromOfficeM > office.radiusM) reasons.push('LOCATION_MISMATCH')
    }
    const lastLocation = recent.find(row => row.latitude != null && row.longitude != null)
    if (lastLocation) {
      const moved = distanceMeters(
        { latitude: Number(lastLocation.latitude), longitude: Number(lastLocation.longitude) },
        { latitude, longitude },
      )
      if (moved >= LOCATION_CHANGE_ALERT_M) reasons.push('LOCATION_CHANGED')
    }
  }

  const uniqueReasons = Array.from(new Set(reasons))
  return {
    suspiciousReasons: uniqueReasons,
    distanceFromOfficeM,
    verificationRequired: uniqueReasons.some(reason => ['NEW_DEVICE', 'FREQUENT_DEVICE_CHANGES', 'LOCATION_CHANGED'].includes(reason)),
    trustStatus: uniqueReasons.length
      ? uniqueReasons.some(reason => ['NEW_DEVICE', 'FREQUENT_DEVICE_CHANGES', 'LOCATION_CHANGED'].includes(reason))
        ? 'REQUIRES_VERIFICATION'
        : 'WARNING'
      : 'TRUSTED',
  } as const
}

export async function postAttendancePenalty(record: Pick<AttendanceRecord, 'id' | 'businessId' | 'employeeId' | 'attendanceDate' | 'penaltyAmount' | 'penaltyLedgerEntryId'> & { lateMinutes?: number | null }, actorUserId?: string | null) {
  const amount = Number(record.penaltyAmount || 0)
  if (!Number.isFinite(amount) || amount <= 0 || record.penaltyLedgerEntryId) return null

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId: record.employeeId,
      businessId: record.businessId,
      type: 'PENALTY',
      amount,
      effectiveDate: record.attendanceDate,
      createdById: actorUserId || null,
      approvedById: actorUserId || null,
      source: LATE_PENALTY_SOURCE,
      sourceRef: attendanceSourceRef(record.businessId, record.employeeId, record.attendanceDate),
      note: latePenaltyNoteBn(record.attendanceDate, Number(record.lateMinutes || 0)),
    })
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { penaltyLedgerEntryId: entry.id },
    })
    return entry
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.employeeLedgerEntry.findUnique({
        where: {
          source_sourceRef: {
            source: LATE_PENALTY_SOURCE,
            sourceRef: attendanceSourceRef(record.businessId, record.employeeId, record.attendanceDate),
          },
        },
      })
      if (existing) {
        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: { penaltyLedgerEntryId: existing.id },
        })
      }
      return existing
    }
    throw e
  }
}

export async function reverseAttendancePenalty(waiver: Pick<AttendanceWaiverRequest, 'id' | 'businessId' | 'employeeId' | 'approvedReductionAmount' | 'reversalLedgerEntryId'> & { penaltyLedgerEntryId?: string | null }, actorUserId?: string | null) {
  const amount = Number(waiver.approvedReductionAmount || 0)
  if (!Number.isFinite(amount) || amount <= 0 || waiver.reversalLedgerEntryId) return null

  const fineEntry = waiver.penaltyLedgerEntryId
    ? await prisma.employeeLedgerEntry.findUnique({
        where: { id: waiver.penaltyLedgerEntryId },
        select: { id: true, date: true },
      })
    : null

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId: waiver.employeeId,
      businessId: waiver.businessId,
      type: 'ADJUSTMENT',
      amount,
      effectiveDate: new Date(),
      createdById: actorUserId || null,
      approvedById: actorUserId || null,
      source: LATE_PENALTY_REVERSAL_SOURCE,
      sourceRef: attendanceReversalSourceRef(waiver.id),
      note: penaltyRefundNoteBn(fineEntry?.date),
      relatedEntryId: fineEntry?.id || waiver.penaltyLedgerEntryId || null,
    })
    await prisma.attendanceWaiverRequest.update({
      where: { id: waiver.id },
      data: { reversalLedgerEntryId: entry.id },
    })
    return entry
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.employeeLedgerEntry.findUnique({
        where: {
          source_sourceRef: {
            source: LATE_PENALTY_REVERSAL_SOURCE,
            sourceRef: attendanceReversalSourceRef(waiver.id),
          },
        },
      })
      if (existing) {
        await prisma.attendanceWaiverRequest.update({
          where: { id: waiver.id },
          data: { reversalLedgerEntryId: existing.id },
        })
      }
      return existing
    }
    throw e
  }
}

export async function notifyAttendancePenalty(
  record: AttendanceRecord,
  userId?: string | null,
  options?: { skipOwnerNotify?: boolean },
) {
  if (Number(record.penaltyAmount || 0) <= 0) return
  const tasks = [
    notifyUser({
      userId,
      businessId: record.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: 'দেরিতে চেক-ইনের জরিমানা',
      message: `${toBnDigits(Number(record.lateMinutes || 0))} মিনিট দেরিতে চেক-ইন — জরিমানা ৳ ${Number(record.penaltyAmount).toLocaleString('en-BD')}। ভুল মনে হলে ${toBnDigits(30)} দিনের মধ্যে ওয়ালেট থেকে আপিল করা যাবে।`,
      actionUrl: '/portal/wallet',
    }),
  ]
  if (!options?.skipOwnerNotify) {
    tasks.push(
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId: record.businessId,
        type: 'PAYROLL_ALERT',
        priority: 'HIGH',
        title: 'Late attendance detected',
        message: `${record.employeeId} was late by ${record.lateMinutes} minutes. Penalty: ৳ ${Number(record.penaltyAmount).toLocaleString('en-BD')}.`,
        actionUrl: '/attendance',
      }),
    )
  }
  await Promise.all(tasks)
}

export async function postEarlyLeavePenalty(
  record: Pick<AttendanceRecord, 'id' | 'businessId' | 'employeeId' | 'attendanceDate'> & { earlyLeavePenaltyAmount?: unknown },
  actorUserId?: string | null,
) {
  const amount = Number(record.earlyLeavePenaltyAmount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return null

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId: record.employeeId,
      businessId: record.businessId,
      type: 'PENALTY',
      amount,
      effectiveDate: record.attendanceDate,
      createdById: actorUserId || null,
      approvedById: actorUserId || null,
      source: EARLY_LEAVE_PENALTY_SOURCE,
      sourceRef: earlyLeaveSourceRef(record.businessId, record.employeeId, record.attendanceDate),
      note: `Early checkout penalty · ${record.attendanceDate.toISOString().slice(0, 10)}`,
    })
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { earlyLeavePenaltyLedgerEntryId: entry.id },
    })
    return entry
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return null
    }
    throw e
  }
}

export async function notifyEarlyLeavePenalty(
  record: AttendanceRecord & { earlyLeaveMinutes?: number | null; earlyLeavePenaltyAmount?: unknown },
  userId?: string | null,
) {
  const amount = Number(record.earlyLeavePenaltyAmount || 0)
  if (amount <= 0) return
  await Promise.all([
    notifyUser({
      userId,
      businessId: record.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: 'Early checkout penalty applied',
      message: `Left ${record.earlyLeaveMinutes || 0} minutes early. Penalty: ৳ ${amount.toLocaleString('en-BD')}.`,
      actionUrl: '/portal/wallet',
    }),
    notifyRole({
      role: 'SUPER_ADMIN',
      businessId: record.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: 'Early checkout detected',
      message: `${record.employeeId} left ${record.earlyLeaveMinutes || 0} minutes early. Penalty: ৳ ${amount.toLocaleString('en-BD')}.`,
      actionUrl: '/attendance',
    }),
  ])
}

export function attendanceRecordDto(
  record: AttendanceRecord & {
    waiverRequests?: AttendanceWaiverRequest[]
    selfieVerifications?: AttendanceSelfieVerification[]
    _count?: { waiverRequests: number; selfieVerifications: number }
  },
) {
  return {
    id: record.id,
    businessId: record.businessId,
    userId: record.userId,
    employeeId: record.employeeId,
    attendanceDate: record.attendanceDate.toISOString(),
    status: record.status,
    checkInAt: record.checkInAt.toISOString(),
    checkOutAt: record.checkOutAt?.toISOString() || null,
    totalWorkMinutes: record.totalWorkMinutes,
    lateMinutes: record.lateMinutes,
    penaltyAmount: Number(record.penaltyAmount || 0),
    penaltyLedgerEntryId: record.penaltyLedgerEntryId,
    earlyLeaveMinutes: record.earlyLeaveMinutes,
    earlyLeavePenaltyAmount: record.earlyLeavePenaltyAmount == null ? null : Number(record.earlyLeavePenaltyAmount),
    earlyLeavePenaltyLedgerEntryId: record.earlyLeavePenaltyLedgerEntryId,
    browserFingerprint: record.browserFingerprint,
    deviceKey: record.deviceKey,
    sessionId: record.sessionId,
    latitude: record.latitude == null ? null : Number(record.latitude),
    longitude: record.longitude == null ? null : Number(record.longitude),
    locationAccuracyM: record.locationAccuracyM,
    distanceFromOfficeM: record.distanceFromOfficeM,
    trustStatus: record.trustStatus,
    suspiciousReasons: record.suspiciousReasons,
    verificationRequired: record.verificationRequired,
    faceVerified: record.faceVerified,
    faceVerifiedAt: record.faceVerifiedAt?.toISOString() ?? null,
    selfieCount:
      record._count?.selfieVerifications ?? record.selfieVerifications?.length ?? 0,
    waiverRequests: (record.waiverRequests || []).map(attendanceWaiverDto),
  }
}

export function attendanceSelfieDto(row: AttendanceSelfieVerification) {
  return {
    id: row.id,
    attendanceRecordId: row.attendanceRecordId,
    businessId: row.businessId,
    userId: row.userId,
    employeeId: row.employeeId,
    deviceKey: row.deviceKey,
    imageDataUrl: row.imageDataUrl,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    capturedAt: row.capturedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() || null,
    reviewedById: row.reviewedById,
    reviewNote: row.reviewNote,
  }
}

export function attendanceWaiverDto(waiver: AttendanceWaiverRequest) {
  const original = Number(waiver.originalPenaltyAmount || 0)
  const approved = waiver.approvedReductionAmount == null ? null : Number(waiver.approvedReductionAmount)
  const isResolved = waiver.status === 'APPROVED' || waiver.status === 'PARTIALLY_APPROVED'
  const reduction = isResolved ? Math.min(original, Math.max(0, Number(approved) || 0)) : 0
  return {
    id: waiver.id,
    attendanceRecordId: waiver.attendanceRecordId,
    businessId: waiver.businessId,
    userId: waiver.userId,
    employeeId: waiver.employeeId,
    status: waiver.status,
    statusLabel: waiver.status === 'APPROVED' ? 'FULLY_APPROVED' : waiver.status,
    requestType: waiver.requestType,
    originalPenaltyAmount: original,
    requestedReductionAmount: waiver.requestedReductionAmount == null ? null : Number(waiver.requestedReductionAmount),
    approvedReductionAmount: approved,
    finalAppliedPenalty: Math.max(0, original - reduction),
    reason: waiver.reason,
    hasAttachment: Boolean(waiver.attachmentDataUrl),
    adminNote: waiver.adminNote,
    reviewedById: waiver.reviewedById,
    reviewedAt: waiver.reviewedAt?.toISOString() || null,
    reversalLedgerEntryId: waiver.reversalLedgerEntryId,
    createdAt: waiver.createdAt.toISOString(),
    updatedAt: waiver.updatedAt.toISOString(),
  }
}

export function workDurationMinutes(checkInAt: Date, checkOutAt: Date) {
  return Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000))
}

export function money(value: unknown) {
  return moneyDecimal(value)
}
