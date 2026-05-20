import type { NextRequest } from 'next/server'
import { normalizeAlmaRole } from '@/lib/roles'
import { resolveAttendanceBusinessScope } from '@/lib/attendance-business'
import { parseArchiveVisibility } from '@/lib/business-archive/query'
import { safeArchiveFilter } from '@/lib/core/safe-archive'
import { safeBusinessAccess } from '@/lib/core/safe-business'
import { attendanceDateFor } from '@/lib/attendance'
import { logEvent } from '@/lib/logger'

export function parseAttendanceDateParam(raw: string | null) {
  if (!raw) return attendanceDateFor()
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return attendanceDateFor()
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

export function attendanceMonthRange(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { start, end }
}

export type SafeAttendanceQueryContext = {
  archiveVisibility: ReturnType<typeof parseArchiveVisibility>
  archiveWhere: Record<string, unknown>
  role: ReturnType<typeof normalizeAlmaRole>
  scopeBusinessIds: ReturnType<typeof resolveAttendanceBusinessScope>
  selectedBusinessId: string
  scopeAllBusinesses: boolean
  date: Date
  monthStart: Date
  monthEnd: Date
}

/** Build attendance list query context (archive + business scope). */
export async function safeAttendanceQuery(req: NextRequest, input: {
  businessIdParam: string | null
  tokenBusinessAccess: string
  role: string
}): Promise<SafeAttendanceQueryContext> {
  const url = new URL(req.url)
  const archiveVisibility = parseArchiveVisibility(url.searchParams.get('archive_visibility'))
  const archiveWhere = await safeArchiveFilter(archiveVisibility)
  const role = normalizeAlmaRole(input.role)
  const scopeBusinessIds = resolveAttendanceBusinessScope(
    input.tokenBusinessAccess,
    input.businessIdParam,
    role,
  )
  const selectedBusinessId = scopeBusinessIds[0]
  if (input.businessIdParam && !safeBusinessAccess(input.tokenBusinessAccess, selectedBusinessId)) {
    logEvent('warn', 'attendance.api.failed', {
      reason: 'business_scope_mismatch',
      requested: input.businessIdParam,
      selected: selectedBusinessId,
    })
  }
  const date = parseAttendanceDateParam(url.searchParams.get('date'))
  const { start: monthStart, end: monthEnd } = attendanceMonthRange(date)
  return {
    archiveVisibility,
    archiveWhere,
    role,
    scopeBusinessIds,
    selectedBusinessId,
    scopeAllBusinesses: scopeBusinessIds.length > 1,
    date,
    monthStart,
    monthEnd,
  }
}

export function classifyAttendanceDbError(err: unknown): {
  code: string
  message: string
  status: number
  retryable: boolean
} {
  const msg = (err as Error).message || String(err)
  if (msg.includes('Unknown argument') && msg.includes('isArchived')) {
    return {
      code: 'ARCHIVE_FILTER_MISMATCH',
      message: 'Attendance archive filter misconfigured. Contact support — data is not lost.',
      status: 500,
      retryable: false,
    }
  }
  if (
    msg.includes('faceVerified')
    || msg.includes('faceThumbDataUrl')
    || msg.includes('requestType')
    || msg.includes('does not exist')
    || msg.includes('Unknown field')
    || (msg.includes('isArchived') && msg.includes('column'))
  ) {
    return {
      code: 'SCHEMA_OUTDATED',
      message: 'Attendance database schema is out of date. Run pending Prisma migrations on production.',
      status: 503,
      retryable: true,
    }
  }
  if (msg.includes('Unable to start a transaction') || msg.includes('pool') || msg.includes('P2024')) {
    return {
      code: 'DB_UNAVAILABLE',
      message: 'Database is busy. Please retry in a few seconds.',
      status: 503,
      retryable: true,
    }
  }
  if (msg.includes('timed out') || msg.includes('Transaction already closed')) {
    return {
      code: 'TIMEOUT',
      message: 'Attendance request timed out. Pull to refresh and retry.',
      status: 503,
      retryable: true,
    }
  }
  return {
    code: 'DB_UNAVAILABLE',
    message: 'Could not load attendance records.',
    status: 500,
    retryable: true,
  }
}
