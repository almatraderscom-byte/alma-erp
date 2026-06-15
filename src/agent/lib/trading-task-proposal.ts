/**
 * Phase 7 — ALMA Trading staff task proposal builder.
 *
 * Mirrors src/agent/lib/staff-task-proposal.ts but pulls from Trading data:
 *   - TradingAccount (per-staff via assignedUserId)
 *   - TradingDailyVolumeTarget (today's USDT target gap)
 *   - TradingEmployeeDailyReport (yesterday submission status)
 *   - TradingPerformanceScreenshot (latest screenshot age)
 *
 * Used only when businessId === 'ALMA_TRADING'.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { TRADING_BUSINESS_ID, numberFromDecimal } from '@/lib/trading'
import {
  isPastScreenshotCutoff,
  screenshotComplianceStatus,
} from '@/lib/trading-compliance'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ProposedTradingTask = {
  staffId: string
  staffName: string
  title: string
  detail?: string
  type: string
  source: string
}

export type TradingProposalResult = {
  success: true
  tasks: ProposedTradingTask[]
  perStaff: Array<{
    staffName: string
    accounts: string[]
    todayTargetUsdt: number
    actualUsdt: number
    gapUsdt: number
    merchantProgress: Array<{ accountTitle: string; target: number; progress: number; pct: number }>
    yesterdayReportSubmitted: boolean
    screenshotStatus: 'COMPLETE' | 'DUE' | 'OVERDUE' | 'UNKNOWN'
  }>
  summaryBangla: string
}

export type TradingProposalError = {
  success: false
  error: string
}

export async function buildTradingTaskProposal(
  dateYmd: string = todayYmdDhaka(),
): Promise<TradingProposalResult | TradingProposalError> {
  const day = new Date(`${dateYmd}T00:00:00+06:00`)
  const next = new Date(day)
  next.setDate(next.getDate() + 1)
  const yesterdayYmd = addDaysYmd(dateYmd, -1)
  const yesterday = new Date(`${yesterdayYmd}T00:00:00+06:00`)
  const yesterdayEnd = new Date(yesterday)
  yesterdayEnd.setDate(yesterdayEnd.getDate() + 1)

  // Trading staff = AgentStaff(businessId='ALMA_TRADING', active=true, userId set)
  const staff = await db.agentStaff.findMany({
    where: { businessId: TRADING_BUSINESS_ID, active: true },
    select: { id: true, name: true, userId: true },
  })
  if (!staff.length) {
    return {
      success: false,
      error:
        'কোনো Trading staff সেটাপ হয়নি (AgentStaff businessId=ALMA_TRADING, active=true)। /agent/trading-staff থেকে staff লিঙ্ক করুন।',
    }
  }

  const linkedUserIds = staff
    .map((s: { userId: string | null }) => s.userId)
    .filter((u: string | null): u is string => Boolean(u))

  const [accounts, volumeTargets, yesterdayReports, screenshotGroups] = await Promise.all([
    db.tradingAccount.findMany({
      where: {
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        status: 'ACTIVE',
        ...(linkedUserIds.length ? { assignedUserId: { in: linkedUserIds } } : {}),
      },
      select: {
        id: true,
        accountTitle: true,
        assignedUserId: true,
        merchantTarget: true,
        merchantProgress: true,
      },
    }),
    db.tradingDailyVolumeTarget.findMany({
      where: { businessId: TRADING_BUSINESS_ID, targetDate: { gte: day, lt: next } },
      select: { tradingAccountId: true, targetUsdt: true, actualUsdt: true, status: true },
    }),
    db.tradingEmployeeDailyReport.findMany({
      where: { businessId: TRADING_BUSINESS_ID, reportDate: { gte: yesterday, lt: yesterdayEnd } },
      select: { userId: true, totalTrades: true },
    }),
    db.tradingPerformanceScreenshot.groupBy({
      by: ['tradingAccountId'],
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
      _max: { shotDate: true },
    }),
  ])

  const accountsByUser = new Map<string, typeof accounts>()
  for (const acc of accounts) {
    if (!acc.assignedUserId) continue
    const list = accountsByUser.get(acc.assignedUserId) ?? []
    list.push(acc)
    accountsByUser.set(acc.assignedUserId, list)
  }

  const volumeByAccount = new Map<string, { target: number; actual: number }>(
    volumeTargets.map((v: { tradingAccountId: string; targetUsdt: unknown; actualUsdt: unknown }) => [
      v.tradingAccountId,
      { target: numberFromDecimal(v.targetUsdt), actual: numberFromDecimal(v.actualUsdt) },
    ]),
  )

  const yesterdayReportByUser = new Map<string, boolean>(
    yesterdayReports.map((r: { userId: string }) => [r.userId, true]),
  )

  const screenshotByAccount = new Map<string, Date | null>(
    screenshotGroups.map((g: { tradingAccountId: string; _max: { shotDate: Date | null } }) => [
      g.tradingAccountId,
      g._max.shotDate,
    ]),
  )

  const tasks: ProposedTradingTask[] = []
  const perStaff: TradingProposalResult['perStaff'] = []

  for (const s of staff) {
    const userAccounts = (s.userId ? accountsByUser.get(s.userId) : []) ?? []
    const accountTitles = userAccounts.map((a: { accountTitle: string }) => a.accountTitle)
    const todayTargetUsdt = userAccounts.reduce(
      (sum: number, a: { id: string }) => sum + (volumeByAccount.get(a.id)?.target ?? 0),
      0,
    )
    const todayActualUsdt = userAccounts.reduce(
      (sum: number, a: { id: string }) => sum + (volumeByAccount.get(a.id)?.actual ?? 0),
      0,
    )
    const gap = Math.max(todayTargetUsdt - todayActualUsdt, 0)

    const merchantProgress = userAccounts
      .filter((a: { merchantTarget: unknown }) => a.merchantTarget != null)
      .map((a: { accountTitle: string; merchantTarget: unknown; merchantProgress: unknown }) => {
        const target = numberFromDecimal(a.merchantTarget)
        const progress = numberFromDecimal(a.merchantProgress)
        return {
          accountTitle: a.accountTitle,
          target,
          progress,
          pct: target > 0 ? Math.round((progress / target) * 100) : 0,
        }
      })

    const yesterdayReportSubmitted = s.userId ? Boolean(yesterdayReportByUser.get(s.userId)) : false

    // Worst screenshot status across this staff's accounts
    let worstStatus: 'COMPLETE' | 'DUE' | 'OVERDUE' | 'UNKNOWN' = 'COMPLETE'
    for (const acc of userAccounts) {
      const last = screenshotByAccount.get(acc.id) ?? null
      const status = screenshotComplianceStatus(last)
      if (status === 'OVERDUE') worstStatus = 'OVERDUE'
      else if (status === 'DUE' && worstStatus !== 'OVERDUE') worstStatus = 'DUE'
      else if (!last && worstStatus === 'COMPLETE') worstStatus = 'UNKNOWN'
    }

    perStaff.push({
      staffName: s.name,
      accounts: accountTitles,
      todayTargetUsdt,
      actualUsdt: todayActualUsdt,
      gapUsdt: gap,
      merchantProgress,
      yesterdayReportSubmitted,
      screenshotStatus: worstStatus,
    })

    // ── Task generation ──────────────────────────────────────────────────────
    if (userAccounts.length === 0) {
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: 'কোনো trading account এখনো assigned হয়নি — owner-কে জানান।',
        type: 'trading_setup',
        source: 'agent',
      })
      continue
    }

    if (!yesterdayReportSubmitted) {
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: `গতকাল (${yesterdayYmd}) এর daily report submit করুন`,
        detail:
          `Accounts: ${accountTitles.join(', ')}. Total trades, profit/loss, issues — Trading bot এ পাঠান অথবা ERP-এ submit করুন।`,
        type: 'trading_report',
        source: 'agent',
      })
    }

    if (gap > 0) {
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: `আজকের USDT volume target পূরণ করুন — gap ${gap.toFixed(2)} USDT`,
        detail:
          `Target ${todayTargetUsdt.toFixed(2)} USDT, achieved ${todayActualUsdt.toFixed(2)} USDT.` +
          ` Accounts: ${accountTitles.join(', ')}.`,
        type: 'trading_volume',
        source: 'agent',
      })
    }

    const lowMerchant = merchantProgress.filter((m: { pct: number }) => m.pct < 100 && m.pct > 0)
    for (const m of lowMerchant) {
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: `${m.accountTitle} — merchant goal ${m.pct}% (${m.progress.toFixed(0)}/${m.target.toFixed(0)})`,
        detail:
          `Merchant target পূরণে আজকে কম পক্ষে কিছু volume add করুন। বাকি ${(m.target - m.progress).toFixed(0)} BDT-volume লাগবে।`,
        type: 'trading_merchant',
        source: 'agent',
      })
    }

    if (worstStatus === 'OVERDUE' || (worstStatus === 'DUE' && isPastScreenshotCutoff())) {
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: `Performance screenshot আজকের জন্য আপলোড করুন (${worstStatus})`,
        detail:
          `Accounts: ${accountTitles.join(', ')}. Binance screenshot upload করুন — owner সকালে review করবেন।`,
        type: 'trading_screenshot',
        source: 'agent',
      })
    }

    if (tasks.filter((t) => t.staffId === s.id).length === 0) {
      // No flagged issue today → still give a standing task to keep activity visible
      tasks.push({
        staffId: s.id,
        staffName: s.name,
        title: `আজকের trading — ${accountTitles.join(', ')} এ স্বাভাবিক operations`,
        detail:
          `Target met হলেও account active রাখুন; কোনো error/issue হলে owner-কে জানান।`,
        type: 'trading_ops',
        source: 'agent',
      })
    }
  }

  const summaryBangla = [
    `📋 ALMA Trading টাস্ক প্রস্তাব — ${dateYmd}`,
    '',
    ...perStaff.map((p) => {
      const accTxt = p.accounts.length ? p.accounts.join(', ') : 'কোনো account না'
      return [
        `• ${p.staffName}`,
        `   Accounts: ${accTxt}`,
        `   Target আজ: ${p.todayTargetUsdt.toFixed(2)} USDT (gap ${p.gapUsdt.toFixed(2)})`,
        `   Merchant: ${p.merchantProgress.length ? p.merchantProgress.map((m) => `${m.accountTitle} ${m.pct}%`).join(', ') : 'কোনো target সেট নেই'}`,
        `   কাল report: ${p.yesterdayReportSubmitted ? '✓ submit হয়েছে' : '✗ এখনো বাকি'}`,
        `   Screenshot: ${p.screenshotStatus}`,
      ].join('\n')
    }),
    '',
    `মোট task: ${tasks.length}। Approve করলে worker Trading staff (ALMA_TRADING) এর Telegram-এ পাঠাবে।`,
  ].join('\n')

  return { success: true, tasks, perStaff, summaryBangla }
}
