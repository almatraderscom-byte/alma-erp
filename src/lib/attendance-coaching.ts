import type { AttendanceRecord } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { countRecentLateDays } from '@/lib/attendance'
import { notifyRole } from '@/lib/notifications'
import { scheduleTelegramNotification, processTelegramNotificationQueue } from '@/lib/telegram-notification/queue'
import { logEvent } from '@/lib/logger'

async function resolveStaffCoachingContext(userId: string, employeeId: string) {
  const user =
    (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })) ??
    (await prisma.user.findFirst({
      where: { employeeIdGas: employeeId },
      select: { name: true },
    }))

  const staffName = user?.name?.trim() || employeeId

  const agentStaff = staffName
    ? await prisma.agentStaff.findFirst({
        where: { name: { equals: staffName, mode: 'insensitive' }, active: true },
        select: { name: true, telegramChatId: true },
      })
    : null

  return {
    staffName: agentStaff?.name || staffName,
    telegramChatId: agentStaff?.telegramChatId ?? null,
  }
}

export async function coachLateCheckIn(args: {
  employeeId: string
  businessId: string
  userId: string
  staffName?: string
  telegramChatId?: string | null
  lateMinutes: number
  penaltyAmount: number
  attendanceDate?: Date
}) {
  let staffName = args.staffName
  let telegramChatId = args.telegramChatId ?? null

  if (!staffName || telegramChatId === undefined) {
    const resolved = await resolveStaffCoachingContext(args.userId, args.employeeId)
    staffName = staffName || resolved.staffName
    telegramChatId = telegramChatId ?? resolved.telegramChatId
  }

  const lateDays = await countRecentLateDays(args.employeeId, args.businessId)

  let staffMsg: string
  let ownerNote: string | null = null

  if (lateDays <= 1) {
    staffMsg =
      `🌅 ${staffName} ভাই, আজ ${args.lateMinutes} মিনিট দেরি হয়েছে। ` +
      `কোনো সমস্যা নেই, তবে অফিস টাইম ৯:৩০ — চেষ্টা করুন সময়মতো আসতে। ৳${args.penaltyAmount} ফাইন হয়েছে। ` +
      `সময়মতো এলে এটা এড়ানো যায়। আগামীকাল সময়মতো দেখা হবে ইনশাআল্লাহ! 🙂`
  } else if (lateDays <= 3) {
    staffMsg =
      `⏰ ${staffName} ভাই, এই সপ্তাহে ${lateDays} দিন দেরি হলো। ` +
      `অফিস টাইম ৯:৩০ মেনে চলা জরুরি — এতে আপনার কাজ আর টিমের সুবিধা হয়। ` +
      `আজ ৳${args.penaltyAmount} ফাইন। নিয়মিত দেরি owner খেয়াল করছেন। দয়া করে সময়ের দিকে নজর দিন।`
    ownerNote = `${staffName} এই সপ্তাহে ${lateDays} দিন দেরি করেছে।`
  } else {
    staffMsg =
      `🔴 ${staffName} ভাই, এই সপ্তাহে ${lateDays} দিন দেরি — এটা আর সাধারণ ব্যাপার নয়। ` +
      `অফিস টাইম ৯:৩০ বারবার মিস হচ্ছে। যত excuse-ই থাকুক, ধারাবাহিক দেরি কাজ আর বিশ্বাস দুটোতেই প্রভাব ফেলে। ` +
      `owner বিষয়টি নিজে দেখছেন। দয়া করে আগামীকাল থেকে সময়মতো আসুন।`
    ownerNote = `🔴 ${staffName} এই সপ্তাহে ${lateDays} দিন দেরি — pattern হয়ে যাচ্ছে। আপনি একবার কথা বললে ভালো হয়।`
  }

  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(
    args.attendanceDate ?? new Date(),
  )

  if (telegramChatId) {
    try {
      const enqueue = await scheduleTelegramNotification({
        businessId: args.businessId,
        eventType: 'ATTENDANCE_CHECK_IN',
        message: staffMsg,
        dedupeKey: `attendance:coach:staff:${args.businessId}:${args.employeeId}:${ymd}`,
        chatIds: [telegramChatId],
        metadata: {
          force: true,
          employeeId: args.employeeId,
          kind: 'late_coaching',
          lateDays,
        },
      })
      if (enqueue.ok && enqueue.ids?.length) {
        await processTelegramNotificationQueue({
          ids: enqueue.ids,
          limit: enqueue.ids.length,
        })
      }
    } catch (err) {
      logEvent('warn', 'attendance.coaching.staff_telegram_failed', {
        employeeId: args.employeeId,
        businessId: args.businessId,
        message: (err as Error).message,
      })
    }
  }

  if (ownerNote) {
    await notifyRole({
      role: 'SUPER_ADMIN',
      businessId: args.businessId,
      type: 'PAYROLL_ALERT',
      priority: lateDays > 3 ? 'HIGH' : 'NORMAL',
      title: 'দেরির প্যাটার্ন',
      message: ownerNote,
      actionUrl: '/attendance',
    }).catch(() => {})
  }
}

export async function coachLateCheckInFromRecord(record: AttendanceRecord, userId: string) {
  if (record.businessId !== 'ALMA_LIFESTYLE' || record.lateMinutes <= 0) return

  await coachLateCheckIn({
    employeeId: record.employeeId,
    businessId: record.businessId,
    userId,
    lateMinutes: record.lateMinutes,
    penaltyAmount: Number(record.penaltyAmount || 0),
    attendanceDate: record.attendanceDate,
  })
}
