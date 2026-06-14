/**
 * Build staff correction notices from outbox facts — never "coming soon" when dispatch already delivered.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CorrectionSituation = 'new_already_sent' | 'awaiting_new_dispatch'

export type StaffCorrectionContext = {
  staffId: string | null
  staffName: string
  situation: CorrectionSituation
  minutesSinceLatestDispatch: number | null
  dispatchCountToday: number
  latestDispatchAt: string | null
}

const RECENT_DISPATCH_MS = 45 * 60 * 1000

const FUTURE_NOTICE_PHRASES = [
  /শীঘ্রই/i,
  /একটু পরে/i,
  /পরে পাঠান/i,
  /পাঠানো হবে/i,
  /আসবে/i,
]

export function buildCorrectionNoticeMessage(
  staffName: string,
  situation: CorrectionSituation,
): string {
  const name = staffName.trim() || 'ভাই'
  if (situation === 'new_already_sent') {
    return (
      `⚠️ গুরুত্বপূর্ণ নোটিশ:\n\n` +
      `আস্সালামু আলাইকুম ${name} ভাই!\n\n` +
      `আগে যে টাস্ক লিস্ট পাঠানো হয়েছিল সেটি বাতিল করা হয়েছে — ওই তালিকা অনুসরণ করবেন না।\n\n` +
      `আপনার কাছে ঠিক মাত্র পাঠানো "📋 আজকের কাজ" লিস্টটিই সঠিক — শুধুমাত্র সেই নতুন তালিকা অনুযায়ী কাজ করুন।\n\n` +
      `জাযাকাল্লাহু খয়রান। 🙏`
    )
  }
  return (
    `⚠️ গুরুত্বপূর্ণ নোটিশ:\n\n` +
    `আস্সালামু আলাইকুম ${name} ভাই!\n\n` +
    `আগের টাস্ক লিস্ট বাতিল হয়েছে। নতুন সঠিক টাস্ক লিস্ট শীঘ্রই পাঠানো হবে — ততক্ষণ অপেক্ষা করুন।\n\n` +
    `জাযাকাল্লাহু খয়রান। 🙏`
  )
}

export async function getStaffDispatchCorrectionContext(
  date: string,
  staffIds?: string[],
): Promise<StaffCorrectionContext[]> {
  const dayStart = new Date(`${date}T00:00:00+06:00`)
  const rows = await db.agentOutbox.findMany({
    where: {
      type: 'task_dispatch',
      createdAt: { gte: dayStart },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      staffId: true,
      staffName: true,
      status: true,
      createdAt: true,
      sentAt: true,
    },
  }) as Array<{
    staffId: string | null
    staffName: string | null
    status: string
    createdAt: Date
    sentAt: Date | null
  }>

  const countByKey = new Map<string, number>()
  for (const r of rows) {
    const key = r.staffId ?? r.staffName ?? 'unknown'
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1)
  }

  const latestByKey = new Map<string, StaffCorrectionContext>()
  for (const r of rows) {
    const key = r.staffId ?? r.staffName ?? 'unknown'
    if (latestByKey.has(key)) continue

    const at = r.sentAt ?? r.createdAt
    const ms = Date.now() - at.getTime()
    const dispatchCount = countByKey.get(key) ?? 1
    const deliveredRecently =
      r.status === 'delivered' && ms >= 0 && ms <= RECENT_DISPATCH_MS

    const situation: CorrectionSituation =
      deliveredRecently || dispatchCount >= 2
        ? 'new_already_sent'
        : 'awaiting_new_dispatch'

    latestByKey.set(key, {
      staffId: r.staffId,
      staffName: r.staffName ?? 'Staff',
      situation,
      minutesSinceLatestDispatch: Math.max(0, Math.round(ms / 60_000)),
      dispatchCountToday: dispatchCount,
      latestDispatchAt: at.toISOString(),
    })
  }

  let list = [...latestByKey.values()]
  if (staffIds?.length) {
    const idSet = new Set(staffIds)
    list = list.filter((s) => s.staffId && idSet.has(s.staffId))
  }

  return list
}

/** Reject freeform announcements that say "coming soon" when dispatch already landed. */
export async function announcementContradictsRecentDispatch(
  message: string,
  date: string,
  staffIds?: string[],
): Promise<{ blocked: boolean; reason?: string }> {
  if (!FUTURE_NOTICE_PHRASES.some((p) => p.test(message))) {
    return { blocked: false }
  }
  const ctx = await getStaffDispatchCorrectionContext(date, staffIds)
  const hasRecent = ctx.some((s) => s.situation === 'new_already_sent')
  if (!hasRecent) return { blocked: false }
  return {
    blocked: true,
    reason:
      'সাম্প্রতিক task_dispatch ইতিমধ্যে পৌঁছেছে — "শীঘ্রই/পরে পাঠানো হবে" বলা যাবে না। ' +
      'send_dispatch_correction_notice টুল ব্যবহার করুন।',
  }
}
