/**
 * Weekly staffing outlook (owner-gated heads-up, no LLM).
 *
 * A simple, HONEST capacity read — not a crystal ball: it pairs this week's order
 * load against the team's task-completion and the pending backlog, and flags when
 * the team looks under-capacity. Always sends a quiet Telegram outlook; only
 * escalates (notifyOwner + a pending action) when capacity is genuinely tight.
 * Mirrors the strategist/reflection/winback delivery pattern.
 */
import { prisma } from '@/lib/prisma'
import { getAgentOrdersSummary, crossCheckPendingCounts } from '@/lib/agent-api/orders.service'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { daysAgoYmd, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any
const DONE_STATUSES = new Set(['done', 'verified', 'done_unverified'])
const BUSINESS_ID = 'ALMA_LIFESTYLE'

async function alreadyPending(type: string): Promise<boolean> {
  try {
    const row = await db.agentPendingAction.findFirst({ where: { type, status: 'pending' }, select: { id: true } })
    return !!row
  } catch {
    return false
  }
}

export async function runStaffForecast(): Promise<{ ordersWeek: number; activeStaff: number; donePct: number; pending: number; flagged: boolean }> {
  const since = new Date(daysAgoYmd(7))
  const [week, pendingCheck, tasks] = await Promise.all([
    getAgentOrdersSummary('week').catch(() => null),
    crossCheckPendingCounts().catch(() => null),
    db.agentStaffTask
      .findMany({
        where: { proposedFor: { gte: since }, status: { notIn: ['cancelled'] }, type: { not: 'learning' } },
        select: { staffId: true, status: true },
      })
      .catch(() => [] as Array<{ staffId: string; status: string }>),
  ])

  const ordersWeek = week?.totalOrders ?? 0
  const pending = pendingCheck?.pendingCount ?? 0
  const total = tasks.length
  const done = tasks.filter((t: { status: string }) => DONE_STATUSES.has(t.status)).length
  const donePct = total ? Math.round((done / total) * 100) : 0
  const activeStaff = new Set(tasks.map((t: { staffId: string }) => t.staffId)).size
  const ordersPerStaff = activeStaff ? Math.round(ordersWeek / activeStaff) : ordersWeek

  // Heuristic: enough signal (>=10 tasks), team finishing < 60%, AND a real backlog
  // (>=10 pending) → likely under-capacity for the current order load.
  const flagged = total >= 10 && donePct < 60 && pending >= 10

  const verdict = flagged
    ? '⚠️ স্টাফ ক্যাপাসিটি টাইট মনে হচ্ছে — কাজ জমছে। লোক বাড়ানো বা কাজ ভাগ করে দেওয়ার কথা ভাবুন।'
    : donePct >= 80
      ? '✅ টিম ভালো সামলাচ্ছে।'
      : 'ℹ️ মোটামুটি চলছে — চোখ রাখুন।'

  const summary =
    `📊 সাপ্তাহিক স্টাফিং আউটলুক (${todayYmdDhaka()}):\n` +
    `• এই সপ্তাহে অর্ডার: ${ordersWeek} (সক্রিয় স্টাফপ্রতি ~${ordersPerStaff})\n` +
    `• সক্রিয় স্টাফ: ${activeStaff} · কাজ শেষ: ${donePct}% (${done}/${total})\n` +
    `• পেন্ডিং অর্ডার: ${pending}\n` +
    verdict

  // Quiet weekly outlook always; escalate only when capacity is flagged.
  if (flagged) {
    await notifyOwner({ tier: 2, title: 'স্টাফিং — মনোযোগ দরকার', message: summary, category: 'report' }).catch(() => {})
    if (!(await alreadyPending('staffing_outlook'))) {
      await db.agentPendingAction
        .create({
          data: {
            type: 'staffing_outlook',
            payload: { ordersWeek, activeStaff, donePct, pending, date: todayYmdDhaka() },
            summary,
            status: 'pending',
            businessId: BUSINESS_ID,
          },
        })
        .catch(() => {})
    }
  }
  void sendOwnerText(summary).catch(() => {})

  return { ordersWeek, activeStaff, donePct, pending, flagged }
}
