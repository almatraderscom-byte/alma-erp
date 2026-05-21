import type {
  AttendanceRecordClient,
  AttendanceWaiverClient,
  MyAttendancePayload,
} from '@/lib/attendance-client'

/** Bump when client payload shape changes — clears stale localStorage caches. */
export const ATTENDANCE_PAYLOAD_VERSION = 2

export function attendanceCacheKey(businessId: string, employeeId: string) {
  return `alma_attendance_me_v${ATTENDANCE_PAYLOAD_VERSION}_${businessId}_${employeeId}`
}

const EMPTY_SUMMARY: MyAttendancePayload['summary'] = {
  presentDays: 0,
  lateCount: 0,
  totalPenalties: 0,
  waivedPenalties: 0,
  averageWorkMinutes: 0,
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function unwrapAttendanceBody(raw: unknown): Record<string, unknown> {
  let body = raw
  for (let depth = 0; depth < 3; depth++) {
    if (!body || typeof body !== 'object') return {}
    const row = body as Record<string, unknown>
    if (row.ok === true && row.data != null && typeof row.data === 'object') {
      body = row.data
      continue
    }
    break
  }
  return (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
}

export function normalizeAttendanceWaiver(raw: unknown): AttendanceWaiverClient | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  return {
    id: r.id,
    status: typeof r.status === 'string' ? r.status : 'PENDING',
    statusLabel: typeof r.statusLabel === 'string' ? r.statusLabel : undefined,
    requestType: typeof r.requestType === 'string' ? r.requestType : undefined,
    reason: typeof r.reason === 'string' ? r.reason : '',
    originalPenaltyAmount: asNumber(r.originalPenaltyAmount),
    requestedReductionAmount:
      r.requestedReductionAmount == null ? null : asNumber(r.requestedReductionAmount),
    approvedReductionAmount:
      r.approvedReductionAmount == null ? null : asNumber(r.approvedReductionAmount),
    finalAppliedPenalty:
      r.finalAppliedPenalty == null ? undefined : asNumber(r.finalAppliedPenalty),
    hasAttachment: asBool(r.hasAttachment, false),
    adminNote: typeof r.adminNote === 'string' ? r.adminNote : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
  }
}

export function normalizeAttendanceRecord(raw: unknown): AttendanceRecordClient | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null

  const waiverRaw = Array.isArray(r.waiverRequests) ? r.waiverRequests : []
  const waivers = waiverRaw
    .map(normalizeAttendanceWaiver)
    .filter((w): w is AttendanceWaiverClient => Boolean(w))

  const checkInAt = typeof r.checkInAt === 'string' && r.checkInAt ? r.checkInAt : ''
  if (!checkInAt) return null

  return {
    id: r.id,
    attendanceDate:
      typeof r.attendanceDate === 'string'
        ? r.attendanceDate
        : new Date().toISOString().slice(0, 10),
    checkInAt,
    checkOutAt: typeof r.checkOutAt === 'string' ? r.checkOutAt : null,
    totalWorkMinutes: asNumber(r.totalWorkMinutes),
    lateMinutes: asNumber(r.lateMinutes),
    penaltyAmount: asNumber(r.penaltyAmount),
    trustStatus: typeof r.trustStatus === 'string' ? r.trustStatus : 'TRUSTED',
    suspiciousReasons: asStringArray(r.suspiciousReasons),
    verificationRequired: asBool(r.verificationRequired, false),
    faceVerified: asBool(r.faceVerified, false),
    faceVerifiedAt: typeof r.faceVerifiedAt === 'string' ? r.faceVerifiedAt : null,
    selfieCount: asNumber(r.selfieCount),
    waiverRequests: waivers,
  }
}

function normalizeSummary(raw: unknown): MyAttendancePayload['summary'] {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SUMMARY }
  const s = raw as Record<string, unknown>
  return {
    presentDays: asNumber(s.presentDays),
    lateCount: asNumber(s.lateCount),
    totalPenalties: asNumber(s.totalPenalties),
    waivedPenalties: asNumber(s.waivedPenalties),
    averageWorkMinutes: asNumber(s.averageWorkMinutes),
  }
}

/** Never throws — safe for render after fetch, cache, or stale PWA payloads. */
export function normalizeMyAttendancePayload(raw: unknown): MyAttendancePayload {
  const body = unwrapAttendanceBody(raw)
  const recordsRaw = Array.isArray(body.records) ? body.records : []
  const waiversRaw = Array.isArray(body.waivers) ? body.waivers : []

  const records = recordsRaw
    .map(normalizeAttendanceRecord)
    .filter((r): r is AttendanceRecordClient => Boolean(r))
  const waivers = waiversRaw
    .map(normalizeAttendanceWaiver)
    .filter((w): w is AttendanceWaiverClient => Boolean(w))

  const today = normalizeAttendanceRecord(body.today)

  return {
    businessId: typeof body.businessId === 'string' ? body.businessId : undefined,
    employeeId:
      body.employeeId == null
        ? null
        : typeof body.employeeId === 'string'
          ? body.employeeId
          : null,
    needsEmployeeLink: asBool(body.needsEmployeeLink, false),
    systemOwner: asBool(body.systemOwner, false),
    today,
    records,
    waivers,
    summary: normalizeSummary(body.summary),
  }
}

export function clearAttendancePortalCache(businessId: string, employeeId?: string | null) {
  if (typeof window === 'undefined') return
  if (employeeId) {
    localStorage.removeItem(attendanceCacheKey(businessId, employeeId))
    return
  }
  const prefix = `alma_attendance_me_v${ATTENDANCE_PAYLOAD_VERSION}_${businessId}_`
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix)) localStorage.removeItem(key)
  }
}

export function readAttendancePortalCache(
  businessId: string,
  employeeId: string,
): MyAttendancePayload | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(attendanceCacheKey(businessId, employeeId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; payload?: unknown }
    if (parsed.version !== ATTENDANCE_PAYLOAD_VERSION) {
      localStorage.removeItem(attendanceCacheKey(businessId, employeeId))
      return null
    }
    return normalizeMyAttendancePayload(parsed.payload)
  } catch {
    localStorage.removeItem(attendanceCacheKey(businessId, employeeId))
    return null
  }
}

export function writeAttendancePortalCache(
  businessId: string,
  employeeId: string,
  payload: MyAttendancePayload,
) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      attendanceCacheKey(businessId, employeeId),
      JSON.stringify({ version: ATTENDANCE_PAYLOAD_VERSION, payload }),
    )
  } catch {
    // quota / private mode — ignore
  }
}

export function formatAttendanceTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
