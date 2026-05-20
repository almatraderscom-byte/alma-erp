import type { BusinessId } from '@/lib/businesses'
import { parseBusinessAccess } from '@/lib/business-access'
import { prisma } from '@/lib/prisma'

/** Comma-separated businessAccess match (avoids Prisma substring false positives). */
export function userHasBusinessAccess(
  businessAccess: string | null | undefined,
  businessId: string,
): boolean {
  const allowed = parseBusinessAccess(businessAccess ?? undefined)
  return allowed.includes(businessId as BusinessId)
}

export function isAllBusinessesScope(raw: string | null | undefined): boolean {
  const v = String(raw || '').trim().toUpperCase()
  return v === 'ALL' || v === '*'
}

export function resolveAttendanceBusinessScope(
  tokenBusinessAccess: string | null | undefined,
  requestedBusinessId: string | null | undefined,
  role: string,
): BusinessId[] {
  const allowed = parseBusinessAccess(tokenBusinessAccess)
  if (role === 'SUPER_ADMIN' && isAllBusinessesScope(requestedBusinessId)) {
    return allowed
  }
  if (requestedBusinessId && allowed.includes(requestedBusinessId as BusinessId)) {
    return [requestedBusinessId as BusinessId]
  }
  return allowed.length ? [allowed[0]] : ['ALMA_LIFESTYLE']
}

export type AttendanceEmployeeRow = {
  id: string
  name: string
  email: string | null
  employeeIdGas: string | null
  profileImageUrl: string | null
  updatedAt: Date
  businessAccess: string
}

export function dedupeEmployeesByUserId(rows: AttendanceEmployeeRow[]): AttendanceEmployeeRow[] {
  const map = new Map<string, AttendanceEmployeeRow>()
  for (const row of rows) {
    if (!row.employeeIdGas) continue
    map.set(row.id, row)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const employeeSelect = {
  id: true,
  name: true,
  email: true,
  employeeIdGas: true,
  profileImageUrl: true,
  updatedAt: true,
  businessAccess: true,
} as const

/** Roster = businessAccess match OR anyone with attendance in this business (repairs hidden activity). */
export async function loadAttendanceRoster(
  businessId: string,
  monthStart: Date,
  monthEnd: Date,
) {
  const [accessUsers, attendeeIds] = await Promise.all([
    prisma.user.findMany({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
      },
      select: employeeSelect,
      orderBy: { name: 'asc' },
    }),
    prisma.attendanceRecord.findMany({
      where: {
        businessId,
        attendanceDate: { gte: monthStart, lt: monthEnd },
      },
      select: { userId: true },
      distinct: ['userId'],
    }),
  ])

  const fromAccess = accessUsers.filter(u => userHasBusinessAccess(u.businessAccess, businessId))
  const accessIds = new Set(fromAccess.map(u => u.id))
  const extraIds = attendeeIds.map(r => r.userId).filter(id => !accessIds.has(id))
  const fromRecords = extraIds.length
    ? await prisma.user.findMany({
        where: { id: { in: extraIds }, active: true },
        select: employeeSelect,
      })
    : []

  return dedupeEmployeesByUserId([...fromAccess, ...fromRecords])
}
