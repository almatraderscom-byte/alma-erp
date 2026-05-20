import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceDateFor, attendanceRecordDto, workDurationMinutes } from '@/lib/attendance'
import { queueAttendanceCheckOutAlert } from '@/lib/telegram-notification/attendance-alerts'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { archiveOpenAssignmentsOnCheckout } from '@/lib/operational-tasks'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { business_id?: string }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.isSystemOwner) {
    return NextResponse.json({ error: 'System owner accounts do not use employee attendance.' }, { status: 403 })
  }
  if (!ctx.employeeId) {
    return NextResponse.json({ error: 'Your user account is not linked to an HR employee ID.' }, { status: 400 })
  }

  const attendanceDate = attendanceDateFor()
  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      businessId_employeeId_attendanceDate: {
        businessId: ctx.businessIds[0],
        employeeId: ctx.employeeId,
        attendanceDate,
      },
    },
  })

  if (!existing) {
    return NextResponse.json({ error: "Start work before ending today's attendance." }, { status: 404 })
  }
  if (existing.checkOutAt) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      record: attendanceRecordDto({ ...existing, waiverRequests: [] }),
    })
  }

  const now = new Date()
  const totalWorkMinutes = workDurationMinutes(existing.checkInAt, now)
  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutAt: now,
      totalWorkMinutes,
      status: 'COMPLETED',
    },
    include: { waiverRequests: true },
  })

  const setting = await getTelegramOpsSetting(ctx.businessIds[0])
  const isEarly = totalWorkMinutes < setting.earlyLeaveMinutes
  queueAttendanceCheckOutAlert({ ...record, checkOutAt: now }, { earlyLeave: isEarly })

  if (ctx.userId) {
    void archiveOpenAssignmentsOnCheckout(ctx.userId).catch(() => {})
  }

  return NextResponse.json({ ok: true, record: attendanceRecordDto(record) })
}
