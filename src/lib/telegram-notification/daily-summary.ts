import { prisma } from '@/lib/prisma'
import { attendanceDateFor } from '@/lib/attendance'
import { businessLabel, erpBaseUrl } from '@/lib/telegram-notification/formatters'
import { enqueueTelegramNotificationAndFlush } from '@/lib/telegram-notification/queue'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import type { BusinessId } from '@/lib/businesses'

function ymdBd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
}

export async function queueOpsDailySummary(businessId: BusinessId) {
  const setting = await getTelegramOpsSetting(businessId)
  if (!setting.alertOpsDailySummary || !setting.enabled) return { skipped: true }

  const today = attendanceDateFor()
  const [employees, records, pendingWaivers] = await Promise.all([
    prisma.user.count({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
        businessAccess: { contains: businessId },
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { businessId, attendanceDate: today },
      select: { lateMinutes: true, penaltyAmount: true, checkOutAt: true },
    }),
    prisma.attendanceWaiverRequest.count({
      where: { businessId, status: 'PENDING' },
    }),
  ])

  const present = records.length
  const late = records.filter(r => r.lateMinutes > 0).length
  const absent = Math.max(0, employees - present)
  const noCheckout = records.filter(r => !r.checkOutAt).length
  const penalties = records.reduce((s, r) => s + Number(r.penaltyAmount || 0), 0)

  const message = [
    `📊 <b>Daily Ops Summary</b> (${ymdBd()})`,
    `<i>${businessLabel(businessId)}</i>`,
    '',
    `👥 Present: <b>${present}</b> / ${employees}`,
    `⚠️ Absent: <b>${absent}</b>`,
    `🔴 Late: <b>${late}</b>`,
    `⏳ No checkout: <b>${noCheckout}</b>`,
    `💰 Penalties: <b>৳ ${penalties.toLocaleString('en-BD')}</b>`,
    `📝 Pending waivers: <b>${pendingWaivers}</b>`,
    '',
    `<a href="${erpBaseUrl()}/attendance?business_id=${businessId}">Open attendance →</a>`,
  ].join('\n')

  enqueueTelegramNotificationAndFlush({
    businessId,
    eventType: 'OPS_DAILY_SUMMARY',
    message,
    dedupeKey: `ops:daily:${businessId}:${ymdBd()}`,
  })

  return { ok: true }
}
