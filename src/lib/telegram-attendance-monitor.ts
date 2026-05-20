import { prisma } from '@/lib/prisma'
import { attendanceDateFor, localMinutesFor } from '@/lib/attendance'
import { userHasBusinessAccess } from '@/lib/attendance-business'
import {
  employeePresentForAbsentMonitor,
  verifyAbsentBeforeTelegramAlert,
} from '@/lib/attendance-absent-safety'
import {
  isPastAbsentThreshold,
  isPastCheckoutCutoff,
  queueAttendanceAbsentAlert,
  queueAttendanceNoCheckoutAlert,
} from '@/lib/telegram-notification/attendance-alerts'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { logEvent } from '@/lib/logger'

export type AttendanceMonitorResult = {
  businessId: string
  absentAlerts: number
  absentBlocked: number
  noCheckoutAlerts: number
  skipped?: string
}

async function monitorBusiness(businessId: BusinessId): Promise<AttendanceMonitorResult> {
  const setting = await getTelegramOpsSetting(businessId)
  if (!setting.enabled) {
    return { businessId, absentAlerts: 0, absentBlocked: 0, noCheckoutAlerts: 0, skipped: 'disabled' }
  }

  const scanStarted = Date.now()
  const now = new Date()
  const today = attendanceDateFor(now)
  const localMin = localMinutesFor(now)
  let absentAlerts = 0
  let absentBlocked = 0
  let noCheckoutAlerts = 0

  logEvent('info', 'attendance.monitor.scan', {
    businessId,
    attendanceDate: today.toISOString(),
    localMinutesBd: localMin,
    scanAt: now.toISOString(),
  })

  const [allActiveEmployees, todayRecords, globalTodayRecords] = await Promise.all([
    prisma.user.findMany({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        employeeIdGas: true,
        businessAccess: true,
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { businessId, attendanceDate: today },
      select: {
        id: true,
        employeeId: true,
        checkInAt: true,
        checkOutAt: true,
        updatedAt: true,
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { attendanceDate: today },
      select: { employeeId: true, businessId: true, checkInAt: true },
    }),
  ])

  const employees = allActiveEmployees.filter(emp =>
    userHasBusinessAccess(emp.businessAccess, businessId),
  )

  const globalPresentEmployeeIds = new Set(globalTodayRecords.map(r => r.employeeId))

  if (
    setting.alertAttendanceAbsent
    && isPastAbsentThreshold(setting.officeStartMinutes, setting.gracePeriodMinutes, now)
  ) {
    const delayMinutes = Math.max(0, localMin - setting.officeStartMinutes)

    for (const emp of employees) {
      if (!emp.employeeIdGas) continue

      const presence = await employeePresentForAbsentMonitor({
        employeeId: emp.employeeIdGas,
        monitorBusinessId: businessId,
        businessAccess: emp.businessAccess,
        attendanceDate: today,
        todayRecordsForBusiness: todayRecords,
        globalPresentEmployeeIds,
      })

      if (presence.present) {
        absentBlocked += 1
        logEvent('info', 'attendance.false_positive_blocked', {
          businessId,
          employeeId: emp.employeeIdGas,
          reason: presence.reason,
          phase: 'monitor_scan',
        })
        continue
      }

      logEvent('info', 'attendance.absent.recheck', {
        businessId,
        employeeId: emp.employeeIdGas,
        phase: 'pre_enqueue',
      })

      const verification = await verifyAbsentBeforeTelegramAlert({
        businessId,
        employeeId: emp.employeeIdGas,
        userId: emp.id,
        businessAccess: emp.businessAccess,
        attendanceDate: today,
        monitorScanAt: now,
      })

      if (!verification.allow) {
        absentBlocked += 1
        logEvent('info', 'attendance.false_positive_blocked', {
          businessId,
          employeeId: emp.employeeIdGas,
          reason: verification.reason,
          phase: 'pre_enqueue_verify',
        })
        continue
      }

      logEvent('info', 'attendance.absent.detected', {
        businessId,
        employeeId: emp.employeeIdGas,
        delayMinutes,
        officeStartMinutes: setting.officeStartMinutes,
        gracePeriodMinutes: setting.gracePeriodMinutes,
      })

      const queued = await queueAttendanceAbsentAlert({
        businessId,
        userId: emp.id,
        employeeId: emp.employeeIdGas,
        employeeName: emp.name,
        phone: emp.phone,
        officeStartMinutes: setting.officeStartMinutes,
        delayMinutes,
        monitorScanAt: now,
      })

      if (queued?.blocked) {
        absentBlocked += 1
      } else if (queued?.queued) {
        absentAlerts += 1
      }
    }
  }

  if (setting.alertAttendanceNoCheckout && isPastCheckoutCutoff(setting.checkoutCutoffMinutes, now)) {
    const openRecords = todayRecords.filter(r => !r.checkOutAt)
    for (const rec of openRecords) {
      const emp = employees.find(e => e.employeeIdGas === rec.employeeId)
      if (!emp) continue
      await queueAttendanceNoCheckoutAlert({
        businessId,
        userId: emp.id,
        employeeId: rec.employeeId,
        employeeName: emp.name,
        checkInAt: rec.checkInAt,
        lastActivityAt: rec.updatedAt,
        attendanceRecordId: rec.id,
      })
      noCheckoutAlerts += 1
    }
  }

  logEvent('info', 'attendance.monitor.scan.complete', {
    businessId,
    absentAlerts,
    absentBlocked,
    noCheckoutAlerts,
    rosterSize: employees.length,
    presentInBusiness: todayRecords.length,
    presentGlobal: globalTodayRecords.length,
    durationMs: Date.now() - scanStarted,
  })

  return { businessId, absentAlerts, absentBlocked, noCheckoutAlerts }
}

export async function runTelegramAttendanceMonitor(): Promise<AttendanceMonitorResult[]> {
  const results: AttendanceMonitorResult[] = []
  for (const biz of BUSINESS_LIST) {
    results.push(await monitorBusiness(biz.id))
  }
  return results
}
