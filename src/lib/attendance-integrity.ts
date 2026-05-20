import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { userHasBusinessAccess } from '@/lib/attendance-business'
import type { BusinessId } from '@/lib/businesses'

export type AttendanceIntegrityIssue =
  | { kind: 'user_missing_employee_id'; userId: string; name: string; businessAccess: string }
  | { kind: 'attendance_user_not_in_roster'; userId: string; employeeId: string; businessId: string; recordCount: number }
  | { kind: 'user_business_mismatch'; userId: string; employeeId: string; businessId: string; businessAccess: string }
  | { kind: 'orphan_attendance_no_user'; recordId: string; userId: string; employeeId: string; businessId: string }
  | { kind: 'cross_business_activity'; businessId: string; todayCount: number }

export async function scanAttendanceIntegrity(businessIds: BusinessId[], today: Date) {
  const issues: AttendanceIntegrityIssue[] = []

  const [users, todayByBusiness] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, role: { not: 'SUPER_ADMIN' } },
      select: {
        id: true,
        name: true,
        employeeIdGas: true,
        businessAccess: true,
      },
    }),
    prisma.attendanceRecord.groupBy({
      by: ['businessId'],
      where: { attendanceDate: today },
      _count: { id: true },
    }),
  ])

  for (const user of users) {
    if (!user.employeeIdGas?.trim()) {
      issues.push({
        kind: 'user_missing_employee_id',
        userId: user.id,
        name: user.name,
        businessAccess: user.businessAccess,
      })
    }
  }

  for (const businessId of businessIds) {
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))

    const roster = users.filter(
      u => u.employeeIdGas && userHasBusinessAccess(u.businessAccess, businessId),
    )
    const rosterIds = new Set(roster.map(u => u.id))

    const monthRecords = await prisma.attendanceRecord.findMany({
      where: { businessId, attendanceDate: { gte: monthStart, lt: monthEnd } },
      select: { id: true, userId: true, employeeId: true },
    })

    const byUser = new Map<string, number>()
    for (const row of monthRecords) {
      byUser.set(row.userId, (byUser.get(row.userId) || 0) + 1)
    }

    for (const [userId, recordCount] of byUser) {
      const user = users.find(u => u.id === userId)
      if (!user) {
        const sample = monthRecords.find(r => r.userId === userId)
        if (sample) {
          issues.push({
            kind: 'orphan_attendance_no_user',
            recordId: sample.id,
            userId,
            employeeId: sample.employeeId,
            businessId,
          })
        }
        continue
      }
      if (!rosterIds.has(userId)) {
        const sample = monthRecords.find(r => r.userId === userId)
        if (user.employeeIdGas && !userHasBusinessAccess(user.businessAccess, businessId)) {
          issues.push({
            kind: 'user_business_mismatch',
            userId,
            employeeId: user.employeeIdGas,
            businessId,
            businessAccess: user.businessAccess,
          })
        } else {
          issues.push({
            kind: 'attendance_user_not_in_roster',
            userId,
            employeeId: user.employeeIdGas || sample?.employeeId || '',
            businessId,
            recordCount,
          })
        }
      }
    }
  }

  const activityMap = new Map(todayByBusiness.map(row => [row.businessId, row._count.id]))
  for (const row of todayByBusiness) {
    if (!businessIds.includes(row.businessId as BusinessId) && row._count.id > 0) {
      issues.push({
        kind: 'cross_business_activity',
        businessId: row.businessId,
        todayCount: row._count.id,
      })
    }
  }

  if (issues.length) {
    logEvent('warn', 'attendance.integrity.issues', {
      count: issues.length,
      sample: issues.slice(0, 6),
      scopedBusinesses: businessIds,
      todayActivity: Object.fromEntries(activityMap),
    })
  }

  return { issues, todayActivityByBusiness: Object.fromEntries(activityMap) }
}
