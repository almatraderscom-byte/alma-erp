import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import { buildAdminAttendanceDashboard } from '@/lib/attendance-admin-dashboard'
import { todayYmdDhaka, dhakaMidnightUtc, daysAgoYmd } from '@/lib/agent-api/dhaka-date'
import type { BusinessId } from '@/lib/businesses'

const BIZ = DEFAULT_AGENT_BUSINESS_ID as BusinessId

export async function getAttendanceToday() {
  const ymd = todayYmdDhaka()
  const date = dhakaMidnightUtc(ymd)
  const monthStart = dhakaMidnightUtc(`${ymd.slice(0, 8)}01`)
  const nextMonth = dhakaMidnightUtc(daysAgoYmd(-32, date))

  const dash = await buildAdminAttendanceDashboard({
    businessIds: [BIZ],
    date,
    monthStart,
    monthEnd: nextMonth,
    scopeAllBusinesses: false,
  })

  const ops = await prisma.telegramOpsSetting.findUnique({
    where: { businessId: BIZ },
  })
  const grace = ops?.gracePeriodMinutes ?? 15
  const officeStart = ops?.officeStartMinutes ?? 540

  const present = dash.records
    .filter(r => r.lateMinutes <= grace)
    .map(r => ({
      employeeId: r.employeeId,
      name: r.employeeName,
      checkIn: r.checkInAt,
      onTime: r.lateMinutes === 0,
    }))

  const late = dash.records
    .filter(r => r.lateMinutes > grace)
    .map(r => ({
      employeeId: r.employeeId,
      name: r.employeeName,
      checkIn: r.checkInAt!,
      minutesLate: r.lateMinutes,
    }))

  const absent = dash.absentEmployees.map(e => ({
    employeeId: e.employeeId!,
    name: e.name,
  }))

  const checkedIn = new Set(dash.records.map(r => r.employeeId))
  const notYetCheckedIn = dash.absentEmployees
    .filter(e => e.employeeId && !checkedIn.has(e.employeeId))
    .map(e => ({ employeeId: e.employeeId!, name: e.name }))

  return {
    date: ymd,
    present,
    absent,
    late,
    notYetCheckedIn,
    meta: { officeStartMinutes: officeStart, gracePeriodMinutes: grace },
  }
}

export async function getAttendanceHistory(employeeId: string, days: number) {
  const startYmd = daysAgoYmd(days)
  const records = await prisma.attendanceRecord.findMany({
    where: {
      businessId: BIZ,
      employeeId,
      isArchived: false,
      attendanceDate: { gte: dhakaMidnightUtc(startYmd) },
    },
    orderBy: { attendanceDate: 'desc' },
    include: { user: { select: { name: true } } },
  })

  const dayRows = records.map(r => ({
    date: r.attendanceDate.toISOString().slice(0, 10),
    status: r.lateMinutes > 0 ? 'late' : 'present',
    checkIn: r.checkInAt.toISOString(),
    checkOut: r.checkOutAt?.toISOString() ?? null,
    hoursWorked: r.totalWorkMinutes > 0 ? Math.round((r.totalWorkMinutes / 60) * 10) / 10 : null,
  }))

  const presentDays = dayRows.filter(d => d.status === 'present' || d.status === 'late').length
  const lateDays = dayRows.filter(d => d.status === 'late').length
  const workingDays = days
  const absentDays = Math.max(0, workingDays - presentDays)

  return {
    employeeId,
    days: dayRows,
    stats: {
      presentDays,
      absentDays,
      lateDays,
      attendanceRatePct: workingDays > 0 ? Math.round((presentDays / workingDays) * 1000) / 10 : 0,
    },
  }
}

export async function createManualAttendance(body: {
  employeeId: string
  date: string
  checkInAt: string
  checkOutAt?: string
  note?: string
}) {
  const user = await prisma.user.findFirst({
    where: { employeeIdGas: body.employeeId, active: true },
    select: { id: true },
  })
  if (!user) throw new Error('Employee user link not found')

  const attendanceDate = dhakaMidnightUtc(body.date)
  const checkIn = new Date(body.checkInAt)
  const checkOut = body.checkOutAt ? new Date(body.checkOutAt) : null
  const workMin = checkOut
    ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60000))
    : 0

  const row = await prisma.attendanceRecord.create({
    data: {
      businessId: BIZ,
      userId: user.id,
      employeeId: body.employeeId,
      attendanceDate,
      checkInAt: checkIn,
      checkOutAt: checkOut,
      totalWorkMinutes: workMin,
      status: 'PRESENT',
      sessionInfo: body.note ? JSON.stringify({ manual: true, note: body.note }) : '{"manual":true}',
    },
  })
  return { id: row.id, status: 'created', createdAt: row.createdAt.toISOString() }
}

export async function patchAttendance(id: string, body: Record<string, unknown>) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { id } })
  if (!existing) return null
  const data: Record<string, unknown> = {}
  if (body.checkInAt) data.checkInAt = new Date(String(body.checkInAt))
  if (body.checkOutAt) data.checkOutAt = new Date(String(body.checkOutAt))
  if (typeof body.lateMinutes === 'number') data.lateMinutes = body.lateMinutes
  const row = await prisma.attendanceRecord.update({ where: { id }, data })
  return { id: row.id, status: 'updated', updatedAt: row.updatedAt.toISOString() }
}

export async function deleteAttendance(id: string) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { id } })
  if (!existing) return null
  await prisma.attendanceRecord.update({
    where: { id },
    data: { isArchived: true, archivedAt: new Date() },
  })
  return { id, status: 'archived' }
}
