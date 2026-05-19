import { prisma } from '@/lib/prisma'
import { attendanceDateFor, localMinutesFor } from '@/lib/attendance'
import {
  isPastAbsentThreshold,
  isPastCheckoutCutoff,
  queueAttendanceAbsentAlert,
  queueAttendanceNoCheckoutAlert,
} from '@/lib/telegram-notification/attendance-alerts'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'

export type AttendanceMonitorResult = {
  businessId: string
  absentAlerts: number
  noCheckoutAlerts: number
  skipped?: string
}

async function monitorBusiness(businessId: BusinessId): Promise<AttendanceMonitorResult> {
  const setting = await getTelegramOpsSetting(businessId)
  if (!setting.enabled) {
    return { businessId, absentAlerts: 0, noCheckoutAlerts: 0, skipped: 'disabled' }
  }

  const now = new Date()
  const today = attendanceDateFor(now)
  const localMin = localMinutesFor(now)
  let absentAlerts = 0
  let noCheckoutAlerts = 0

  const employees = await prisma.user.findMany({
    where: {
      active: true,
      role: { not: 'SUPER_ADMIN' },
      employeeIdGas: { not: null },
      businessAccess: { contains: businessId },
    },
    select: { id: true, name: true, phone: true, employeeIdGas: true },
  })

  const todayRecords = await prisma.attendanceRecord.findMany({
    where: { businessId, attendanceDate: today },
    select: {
      id: true,
      employeeId: true,
      checkInAt: true,
      checkOutAt: true,
      updatedAt: true,
    },
  })

  const presentIds = new Set(todayRecords.map(r => r.employeeId))

  if (
    setting.alertAttendanceAbsent &&
    isPastAbsentThreshold(setting.officeStartMinutes, setting.gracePeriodMinutes, now)
  ) {
    const delayMinutes = Math.max(0, localMin - setting.officeStartMinutes)

    for (const emp of employees) {
      if (!emp.employeeIdGas || presentIds.has(emp.employeeIdGas)) continue
      await queueAttendanceAbsentAlert({
        businessId,
        userId: emp.id,
        employeeId: emp.employeeIdGas,
        employeeName: emp.name,
        phone: emp.phone,
        officeStartMinutes: setting.officeStartMinutes,
        delayMinutes,
      })
      absentAlerts += 1
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

  return { businessId, absentAlerts, noCheckoutAlerts }
}

export async function runTelegramAttendanceMonitor(): Promise<AttendanceMonitorResult[]> {
  const results: AttendanceMonitorResult[] = []
  for (const biz of BUSINESS_LIST) {
    results.push(await monitorBusiness(biz.id))
  }
  return results
}
