/**
 * Phase 7 — ALMA Trading agent read tools.
 *
 * Thin read-only wrappers over Trading prisma models scoped to
 * `businessId = 'ALMA_TRADING'`. The agent runs as super-admin so it can
 * bypass the per-user `getTradingContext` HTTP guard and read directly.
 *
 * All tools are SAFE FOR LIFESTYLE CONVERSATIONS — they always filter by
 * 'ALMA_TRADING' and never leak Lifestyle data. But the registry only
 * exposes them when businessId === 'ALMA_TRADING'.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import { TRADING_BUSINESS_ID, numberFromDecimal, todayRange } from '@/lib/trading'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function startOfDay(input: string | Date | undefined) {
  const d = input ? new Date(input) : new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function nextDay(d: Date) {
  const n = new Date(d)
  n.setDate(n.getDate() + 1)
  return n
}

// ── get_trading_dashboard ────────────────────────────────────────────────────

const get_trading_dashboard: AgentTool = {
  name: 'get_trading_dashboard',
  description:
    "Returns today's ALMA Trading dashboard snapshot: KPIs (active accounts, USDT volume, profit/loss, fees), per-account performance, merchant progress, and active alerts. Use FIRST when the owner asks about Trading status / dashboard / today.",
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { start, end } = todayRange()
      const accounts = await db.tradingAccount.findMany({
        where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: {
          id: true,
          accountTitle: true,
          accountType: true,
          status: true,
          assignedUserId: true,
          assignedUser: { select: { id: true, name: true, email: true } },
          currentBalance: true,
          startingCapital: true,
          totalProfit: true,
          totalLoss: true,
          totalFees: true,
          totalExpenses: true,
          totalBuyUsdt: true,
          totalSellUsdt: true,
          totalBuyBdt: true,
          totalSellBdt: true,
          usdtBalance: true,
          netRoi: true,
          merchantTarget: true,
          merchantProgress: true,
          updatedAt: true,
        },
      })

      const accountIds = accounts.map((a: { id: string }) => a.id)
      const snapshots = accountIds.length
        ? await db.tradingDailySnapshot.findMany({
            where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, date: { gte: start, lt: end } },
            select: { tradingAccountId: true, tradeCount: true, usdtVolume: true, buyUsdtVolume: true, sellUsdtVolume: true, buyBdtVolume: true, sellBdtVolume: true, grossProfitBdt: true, grossLossBdt: true, feeBdt: true, expenseBdt: true, netResultBdt: true },
          })
        : []

      const bkash = accountIds.length
        ? await db.tradingBkashDailySummary.findMany({
            where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, summaryDate: { gte: start, lt: end } },
            select: { totalOrders: true, totalProfitBdt: true, totalLossBdt: true },
          })
        : []

      const todayBkashOrders = bkash.reduce((s: number, r: { totalOrders: number }) => s + r.totalOrders, 0)
      const todayBkashProfit = bkash.reduce((s: number, r: { totalProfitBdt: unknown }) => s + numberFromDecimal(r.totalProfitBdt), 0)
      const todayBkashLoss = bkash.reduce((s: number, r: { totalLossBdt: unknown }) => s + numberFromDecimal(r.totalLossBdt), 0)

      const sum = (rows: typeof snapshots, field: string) =>
        rows.reduce((s: number, r: Record<string, unknown>) => s + numberFromDecimal(r[field]), 0)
      const tradesCount = snapshots.reduce((s: number, r: { tradeCount: number }) => s + r.tradeCount, 0)

      const todayUsdtVolume = sum(snapshots, 'usdtVolume')
      const todayBuyUsdt = sum(snapshots, 'buyUsdtVolume')
      const todaySellUsdt = sum(snapshots, 'sellUsdtVolume')
      const todayBuyBdt = sum(snapshots, 'buyBdtVolume')
      const todaySellBdt = sum(snapshots, 'sellBdtVolume')
      const todayProfit = sum(snapshots, 'grossProfitBdt') + todayBkashProfit
      const todayLoss = sum(snapshots, 'grossLossBdt') + todayBkashLoss
      const todayFees = sum(snapshots, 'feeBdt')
      const todayExpenses = sum(snapshots, 'expenseBdt')
      const netToday = todayProfit - todayLoss - todayExpenses

      const totalCapital = accounts.reduce((s: number, a: { startingCapital: unknown }) => s + numberFromDecimal(a.startingCapital), 0)
      const currentBalance = accounts.reduce((s: number, a: { currentBalance: unknown }) => s + numberFromDecimal(a.currentBalance), 0)
      const activeAccountsCount = accounts.filter((a: { status: string }) => a.status === 'ACTIVE').length
      const activeStaffSet = new Set(
        accounts
          .filter((a: { status: string; assignedUserId: string | null }) => a.status === 'ACTIVE' && a.assignedUserId)
          .map((a: { assignedUserId: string | null }) => a.assignedUserId),
      )

      const accountPerformance = accounts.map((a: typeof accounts[number]) => {
        const profit = numberFromDecimal(a.totalProfit)
        const loss = numberFromDecimal(a.totalLoss)
        const expenses = numberFromDecimal(a.totalExpenses)
        const target = a.merchantTarget != null ? numberFromDecimal(a.merchantTarget) : null
        const progress = numberFromDecimal(a.merchantProgress)
        return {
          id: a.id,
          accountTitle: a.accountTitle,
          accountType: a.accountType,
          status: a.status,
          assignedStaff: a.assignedUser?.name ?? 'Unassigned',
          currentBalance: numberFromDecimal(a.currentBalance),
          startingCapital: numberFromDecimal(a.startingCapital),
          totalProfit: profit,
          totalLoss: loss,
          totalExpenses: expenses,
          netProfitToDate: profit - loss - expenses,
          netRoi: numberFromDecimal(a.netRoi),
          totalUsdtVolume: numberFromDecimal(a.totalBuyUsdt) + numberFromDecimal(a.totalSellUsdt),
          totalBdtVolume: numberFromDecimal(a.totalBuyBdt) + numberFromDecimal(a.totalSellBdt),
          merchantTarget: target,
          merchantProgress: progress,
          merchantProgressPct: target ? Math.round((progress / target) * 100) : null,
        }
      })

      return {
        success: true,
        data: {
          date: start.toISOString().slice(0, 10),
          timezone: 'Asia/Dhaka',
          kpis: {
            activeAccounts: activeAccountsCount,
            todayTradeCount: tradesCount + todayBkashOrders,
            todayUsdtVolume,
            todayBuyUsdt,
            todaySellUsdt,
            todayBuyBdt,
            todaySellBdt,
            todayProfit,
            todayLoss,
            todayFees,
            todayExpenses,
            netTodayResult: netToday,
            totalCapital,
            currentBalance,
            activeStaffCount: activeStaffSet.size,
          },
          accountPerformance,
          summaryBangla:
            accountPerformance.length === 0
              ? 'কোনো trading account এখনো সেটাপ হয়নি।'
              : `${activeAccountsCount} সক্রিয় account, ${tradesCount + todayBkashOrders} টা trade আজ, USDT volume ${todayUsdtVolume.toFixed(2)}, net BDT ${Math.round(netToday)}৳।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_accounts ─────────────────────────────────────────────────────

const get_trading_accounts: AgentTool = {
  name: 'get_trading_accounts',
  description:
    'Returns ALMA Trading accounts (active + inactive) with assigned staff, balances, merchant target/progress, total USDT volume, and ROI. Use when the owner asks "ki ki account ase" or wants per-account snapshot.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'CLOSED', 'ALL'], description: 'Filter by status (default ACTIVE)' },
    },
  },
  handler: async (input) => {
    try {
      const statusFilter = String(input.status ?? 'ACTIVE')
      const where: Record<string, unknown> = { businessId: TRADING_BUSINESS_ID, deletedAt: null }
      if (statusFilter !== 'ALL') where.status = statusFilter
      const accounts = await db.tradingAccount.findMany({
        where,
        orderBy: [{ status: 'asc' }, { accountTitle: 'asc' }],
        select: {
          id: true,
          accountTitle: true,
          accountType: true,
          status: true,
          binanceUid: true,
          assignedUser: { select: { id: true, name: true, email: true, employeeIdGas: true } },
          startingCapital: true,
          currentBalance: true,
          usdtBalance: true,
          totalProfit: true,
          totalLoss: true,
          totalFees: true,
          totalExpenses: true,
          totalBuyUsdt: true,
          totalSellUsdt: true,
          totalBuyBdt: true,
          totalSellBdt: true,
          netRoi: true,
          merchantTarget: true,
          merchantProgress: true,
          partnershipEnabled: true,
          staffSharePercent: true,
          updatedAt: true,
        },
      })
      const rows = accounts.map((a: typeof accounts[number]) => {
        const target = a.merchantTarget != null ? numberFromDecimal(a.merchantTarget) : null
        const progress = numberFromDecimal(a.merchantProgress)
        return {
          id: a.id,
          accountTitle: a.accountTitle,
          accountType: a.accountType,
          status: a.status,
          binanceUid: a.binanceUid,
          assignedStaff: a.assignedUser
            ? { id: a.assignedUser.id, name: a.assignedUser.name, employeeIdGas: a.assignedUser.employeeIdGas }
            : null,
          startingCapital: numberFromDecimal(a.startingCapital),
          currentBalance: numberFromDecimal(a.currentBalance),
          usdtBalance: numberFromDecimal(a.usdtBalance),
          totalProfit: numberFromDecimal(a.totalProfit),
          totalLoss: numberFromDecimal(a.totalLoss),
          totalFees: numberFromDecimal(a.totalFees),
          totalExpenses: numberFromDecimal(a.totalExpenses),
          totalBuyUsdt: numberFromDecimal(a.totalBuyUsdt),
          totalSellUsdt: numberFromDecimal(a.totalSellUsdt),
          totalUsdtVolume: numberFromDecimal(a.totalBuyUsdt) + numberFromDecimal(a.totalSellUsdt),
          totalBdtVolume: numberFromDecimal(a.totalBuyBdt) + numberFromDecimal(a.totalSellBdt),
          netRoi: numberFromDecimal(a.netRoi),
          merchantTarget: target,
          merchantProgress: progress,
          merchantProgressPct: target ? Math.round((progress / target) * 100) : null,
          partnershipEnabled: a.partnershipEnabled,
          staffSharePercent: numberFromDecimal(a.staffSharePercent),
          updatedAt: a.updatedAt.toISOString(),
        }
      })
      return { success: true, data: { count: rows.length, accounts: rows } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_account_detail ───────────────────────────────────────────────

const get_trading_account_detail: AgentTool = {
  name: 'get_trading_account_detail',
  description:
    'Returns full detail for a single Trading account by id or accountTitle (substring match): recent trades, capital entries, partnership status, latest screenshots, alerts.',
  input_schema: {
    type: 'object' as const,
    properties: {
      accountId: { type: 'string' },
      accountTitle: { type: 'string', description: 'Substring match if accountId not given' },
      tradeLimit: { type: 'number', description: 'How many recent trades to return (default 15, max 50)' },
    },
  },
  handler: async (input) => {
    try {
      const accountId = input.accountId ? String(input.accountId) : null
      const accountTitle = input.accountTitle ? String(input.accountTitle).trim() : null
      const tradeLimit = Math.min(Math.max(Number(input.tradeLimit ?? 15), 1), 50)

      if (!accountId && !accountTitle) {
        return { success: false, error: 'accountId অথবা accountTitle লাগবে।' }
      }

      const account = await db.tradingAccount.findFirst({
        where: {
          businessId: TRADING_BUSINESS_ID,
          deletedAt: null,
          ...(accountId
            ? { id: accountId }
            : { accountTitle: { contains: accountTitle!, mode: 'insensitive' } }),
        },
        select: {
          id: true,
          accountTitle: true,
          accountType: true,
          status: true,
          binanceUid: true,
          assignedUser: { select: { id: true, name: true, email: true } },
          startingCapital: true,
          currentBalance: true,
          usdtBalance: true,
          totalProfit: true,
          totalLoss: true,
          totalFees: true,
          totalExpenses: true,
          totalBuyUsdt: true,
          totalSellUsdt: true,
          totalBuyBdt: true,
          totalSellBdt: true,
          netRoi: true,
          merchantTarget: true,
          merchantProgress: true,
          partnershipEnabled: true,
          staffSharePercent: true,
          partnershipBaselineProfit: true,
          partnershipBaselineLoss: true,
          updatedAt: true,
        },
      })

      if (!account) return { success: false, error: 'Account পাওয়া যায়নি।' }

      const [trades, capitalEntries, latestScreenshot] = await Promise.all([
        db.tradingTrade.findMany({
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: account.id, deletedAt: null, isArchived: false },
          orderBy: { tradeDate: 'desc' },
          take: tradeLimit,
          select: { id: true, tradeType: true, usdtAmount: true, bdtRate: true, netProfit: true, feeBdt: true, tradeDate: true, user: { select: { name: true } } },
        }),
        db.tradingCapitalEntry.findMany({
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: account.id, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, entryType: true, amount: true, notes: true, createdAt: true, creator: { select: { name: true } } },
        }),
        db.tradingPerformanceScreenshot.findFirst({
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: account.id, deletedAt: null, archivedAt: null },
          orderBy: { shotDate: 'desc' },
          select: { id: true, shotDate: true, originalName: true, previewUrl: true, expiryDate: true, uploader: { select: { name: true } } },
        }),
      ])

      const target = account.merchantTarget != null ? numberFromDecimal(account.merchantTarget) : null
      const progress = numberFromDecimal(account.merchantProgress)

      return {
        success: true,
        data: {
          account: {
            id: account.id,
            accountTitle: account.accountTitle,
            accountType: account.accountType,
            status: account.status,
            binanceUid: account.binanceUid,
            assignedStaff: account.assignedUser?.name ?? 'Unassigned',
            startingCapital: numberFromDecimal(account.startingCapital),
            currentBalance: numberFromDecimal(account.currentBalance),
            usdtBalance: numberFromDecimal(account.usdtBalance),
            totalProfit: numberFromDecimal(account.totalProfit),
            totalLoss: numberFromDecimal(account.totalLoss),
            totalFees: numberFromDecimal(account.totalFees),
            totalExpenses: numberFromDecimal(account.totalExpenses),
            totalUsdtVolume: numberFromDecimal(account.totalBuyUsdt) + numberFromDecimal(account.totalSellUsdt),
            netRoi: numberFromDecimal(account.netRoi),
            merchantTarget: target,
            merchantProgress: progress,
            merchantProgressPct: target ? Math.round((progress / target) * 100) : null,
            partnership: account.partnershipEnabled
              ? {
                  enabled: true,
                  staffSharePercent: numberFromDecimal(account.staffSharePercent),
                  baselineProfit: numberFromDecimal(account.partnershipBaselineProfit),
                  baselineLoss: numberFromDecimal(account.partnershipBaselineLoss),
                }
              : { enabled: false },
          },
          recentTrades: trades.map((t: typeof trades[number]) => ({
            id: t.id,
            tradeType: t.tradeType,
            usdtAmount: numberFromDecimal(t.usdtAmount),
            bdtRate: numberFromDecimal(t.bdtRate),
            netProfit: numberFromDecimal(t.netProfit),
            feeBdt: numberFromDecimal(t.feeBdt),
            tradeDate: t.tradeDate.toISOString(),
            staff: t.user?.name,
          })),
          recentCapital: capitalEntries.map((c: typeof capitalEntries[number]) => ({
            id: c.id,
            entryType: c.entryType,
            amount: numberFromDecimal(c.amount),
            notes: c.notes,
            createdAt: c.createdAt.toISOString(),
            createdBy: c.creator?.name,
          })),
          latestScreenshot: latestScreenshot
            ? {
                id: latestScreenshot.id,
                shotDate: latestScreenshot.shotDate.toISOString(),
                fileName: latestScreenshot.originalName,
                expiryDate: latestScreenshot.expiryDate.toISOString(),
                uploadedBy: latestScreenshot.uploader?.name,
              }
            : null,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_trades_today ─────────────────────────────────────────────────

const get_trading_trades_today: AgentTool = {
  name: 'get_trading_trades_today',
  description:
    "Returns today's trades across all Trading accounts (or filtered by accountId). Shows tradeType, USDT amount, BDT rate, profit per trade and staff name. Use for 'aaj koto trade hoyese' questions.",
  input_schema: {
    type: 'object' as const,
    properties: {
      accountId: { type: 'string', description: 'Optional — filter by single account' },
      date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
    },
  },
  handler: async (input) => {
    try {
      const day = startOfDay(input.date ? String(input.date) : undefined)
      const next = nextDay(day)
      const accountId = input.accountId ? String(input.accountId) : null

      const trades = await db.tradingTrade.findMany({
        where: {
          businessId: TRADING_BUSINESS_ID,
          tradeDate: { gte: day, lt: next },
          deletedAt: null,
          isArchived: false,
          ...(accountId ? { tradingAccountId: accountId } : {}),
        },
        orderBy: { tradeDate: 'desc' },
        select: {
          id: true,
          tradeType: true,
          usdtAmount: true,
          bdtRate: true,
          totalBdt: true,
          netProfit: true,
          feeBdt: true,
          tradeDate: true,
          tradingAccount: { select: { id: true, accountTitle: true } },
          user: { select: { name: true } },
        },
      })

      const totalBuy = trades.filter((t: { tradeType: string }) => t.tradeType === 'BUY').reduce((s: number, t: { usdtAmount: unknown }) => s + numberFromDecimal(t.usdtAmount), 0)
      const totalSell = trades.filter((t: { tradeType: string }) => t.tradeType === 'SELL').reduce((s: number, t: { usdtAmount: unknown }) => s + numberFromDecimal(t.usdtAmount), 0)
      const totalProfit = trades.reduce((s: number, t: { netProfit: unknown }) => s + numberFromDecimal(t.netProfit), 0)
      const totalFee = trades.reduce((s: number, t: { feeBdt: unknown }) => s + numberFromDecimal(t.feeBdt), 0)

      return {
        success: true,
        data: {
          date: day.toISOString().slice(0, 10),
          accountId,
          totals: {
            count: trades.length,
            buyUsdt: totalBuy,
            sellUsdt: totalSell,
            usdtVolume: totalBuy + totalSell,
            netProfitBdt: totalProfit,
            feeBdt: totalFee,
          },
          trades: trades.map((t: typeof trades[number]) => ({
            id: t.id,
            tradeType: t.tradeType,
            usdtAmount: numberFromDecimal(t.usdtAmount),
            bdtRate: numberFromDecimal(t.bdtRate),
            totalBdt: numberFromDecimal(t.totalBdt),
            netProfit: numberFromDecimal(t.netProfit),
            feeBdt: numberFromDecimal(t.feeBdt),
            tradeDate: t.tradeDate.toISOString(),
            account: t.tradingAccount?.accountTitle,
            accountId: t.tradingAccount?.id,
            staff: t.user?.name,
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_volume_targets ───────────────────────────────────────────────────────

const get_volume_targets: AgentTool = {
  name: 'get_volume_targets',
  description:
    "Returns today's (or given date's) per-account USDT volume targets, actuals, status (PENDING/APPLIED/WAIVED), and pending penalties. Use for daily volume tracking questions.",
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const day = startOfDay(input.date ? String(input.date) : undefined)
      const next = nextDay(day)

      const rows = await db.tradingDailyVolumeTarget.findMany({
        where: { businessId: TRADING_BUSINESS_ID, targetDate: { gte: day, lt: next } },
        select: {
          id: true,
          tradingAccountId: true,
          tradingAccount: { select: { accountTitle: true, assignedUser: { select: { name: true } } } },
          targetDate: true,
          targetUsdt: true,
          actualUsdt: true,
          status: true,
          penaltyAmountBdt: true,
          notes: true,
          ignoredAt: true,
        },
      })

      const data = rows.map((r: typeof rows[number]) => {
        const target = numberFromDecimal(r.targetUsdt)
        const actual = numberFromDecimal(r.actualUsdt)
        return {
          id: r.id,
          accountId: r.tradingAccountId,
          accountTitle: r.tradingAccount?.accountTitle,
          assignedStaff: r.tradingAccount?.assignedUser?.name,
          targetUsdt: target,
          actualUsdt: actual,
          gap: target - actual,
          progressPct: target > 0 ? Math.round((actual / target) * 100) : 0,
          status: r.status,
          penaltyBdt: r.penaltyAmountBdt != null ? numberFromDecimal(r.penaltyAmountBdt) : null,
          ignoredAt: r.ignoredAt?.toISOString() ?? null,
          notes: r.notes,
        }
      })

      const totalTarget = data.reduce((s: number, r: { targetUsdt: number }) => s + r.targetUsdt, 0)
      const totalActual = data.reduce((s: number, r: { actualUsdt: number }) => s + r.actualUsdt, 0)

      return {
        success: true,
        data: {
          date: day.toISOString().slice(0, 10),
          totals: {
            count: data.length,
            totalTargetUsdt: totalTarget,
            totalActualUsdt: totalActual,
            gapUsdt: totalTarget - totalActual,
            overallProgressPct: totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0,
            pendingCount: data.filter((d: { status: string }) => d.status === 'PENDING').length,
          },
          targets: data,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_merchant_progress ────────────────────────────────────────────────────

const get_merchant_progress: AgentTool = {
  name: 'get_merchant_progress',
  description:
    'Returns per-account merchant target vs progress (the BIG goal of converting an account into Binance merchant). Use when owner asks "merchant goal koi" or wants merchant-conversion progress.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const accounts = await db.tradingAccount.findMany({
        where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, merchantTarget: { not: null } },
        orderBy: { accountTitle: 'asc' },
        select: {
          id: true,
          accountTitle: true,
          accountType: true,
          status: true,
          assignedUser: { select: { name: true } },
          merchantTarget: true,
          merchantProgress: true,
        },
      })

      const data = accounts.map((a: typeof accounts[number]) => {
        const target = numberFromDecimal(a.merchantTarget)
        const progress = numberFromDecimal(a.merchantProgress)
        const remaining = Math.max(target - progress, 0)
        return {
          accountId: a.id,
          accountTitle: a.accountTitle,
          accountType: a.accountType,
          status: a.status,
          assignedStaff: a.assignedUser?.name ?? 'Unassigned',
          target,
          progress,
          remaining,
          progressPct: target > 0 ? Math.round((progress / target) * 100) : 0,
        }
      })

      return {
        success: true,
        data: {
          count: data.length,
          accounts: data,
          note:
            data.length === 0
              ? 'কোনো account এ merchant target সেট করা নেই।'
              : 'প্রতিটি account এর merchant target vs current progress।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_employee_reports ─────────────────────────────────────────────

const get_trading_employee_reports: AgentTool = {
  name: 'get_trading_employee_reports',
  description:
    "Returns Trading employees' daily reports for today (or given date): who submitted, P/L, issues. Lists staff who have NOT yet submitted. Use for 'kalker report koi'/'submission status' questions.",
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
    },
  },
  handler: async (input) => {
    try {
      const day = startOfDay(input.date ? String(input.date) : undefined)
      const next = nextDay(day)

      const [profiles, reports] = await Promise.all([
        db.tradingEmployeeProfile.findMany({
          where: { businessId: TRADING_BUSINESS_ID, status: 'ACTIVE' },
          select: {
            id: true,
            userId: true,
            user: { select: { name: true } },
            roleTitle: true,
            shift: true,
          },
        }),
        db.tradingEmployeeDailyReport.findMany({
          where: { businessId: TRADING_BUSINESS_ID, reportDate: { gte: day, lt: next } },
          select: {
            id: true,
            userId: true,
            user: { select: { name: true } },
            accountIds: true,
            totalTrades: true,
            dailyProfitBdt: true,
            dailyLossBdt: true,
            issues: true,
            submittedAt: true,
            operationalNotes: true,
          },
        }),
      ])

      const reportByUser = new Map<string, typeof reports[number]>(
        reports.map((r: typeof reports[number]) => [r.userId, r]),
      )

      const rows = profiles.map((p: typeof profiles[number]) => {
        const r = reportByUser.get(p.userId)
        return {
          userId: p.userId,
          name: p.user?.name,
          roleTitle: p.roleTitle,
          shift: p.shift,
          submitted: Boolean(r),
          submittedAt: r?.submittedAt?.toISOString() ?? null,
          totalTrades: r?.totalTrades ?? null,
          dailyProfit: r ? numberFromDecimal(r.dailyProfitBdt) : null,
          dailyLoss: r ? numberFromDecimal(r.dailyLossBdt) : null,
          netResult: r ? numberFromDecimal(r.dailyProfitBdt) - numberFromDecimal(r.dailyLossBdt) : null,
          issues: r?.issues ?? null,
          notes: r?.operationalNotes ?? null,
          accountIds: r?.accountIds ?? [],
        }
      })

      const submittedCount = rows.filter((r: { submitted: boolean }) => r.submitted).length
      const pending = rows.filter((r: { submitted: boolean }) => !r.submitted)

      return {
        success: true,
        data: {
          date: day.toISOString().slice(0, 10),
          totals: {
            activeStaff: profiles.length,
            submittedCount,
            pendingCount: pending.length,
            totalProfit: rows.reduce((s: number, r: { dailyProfit: number | null }) => s + (r.dailyProfit ?? 0), 0),
            totalLoss: rows.reduce((s: number, r: { dailyLoss: number | null }) => s + (r.dailyLoss ?? 0), 0),
          },
          rows,
          pendingStaffNames: pending.map((p: { name: string | undefined }) => p.name).filter(Boolean),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_daily_summary ────────────────────────────────────────────────

const get_trading_daily_summary: AgentTool = {
  name: 'get_trading_daily_summary',
  description:
    "Single-call digest: today's KPIs + volume target gap + merchant progress + missing daily reports + alerts. Use for the owner's morning/evening Trading briefing.",
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
    },
  },
  handler: async (input) => {
    try {
      const dateYmd = input.date ? String(input.date) : undefined
      const dash = await get_trading_dashboard.handler({})
      const targets = await get_volume_targets.handler({ date: dateYmd })
      const merchants = await get_merchant_progress.handler({})
      const reports = await get_trading_employee_reports.handler({ date: dateYmd })

      return {
        success: true,
        data: {
          dashboard: dash.success ? dash.data : { error: dash.error },
          volumeTargets: targets.success ? targets.data : { error: targets.error },
          merchantProgress: merchants.success ? merchants.data : { error: merchants.error },
          dailyReports: reports.success ? reports.data : { error: reports.error },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_trading_bkash_summary ────────────────────────────────────────────────

const get_trading_bkash_summary: AgentTool = {
  name: 'get_trading_bkash_summary',
  description:
    "Returns today's bKash daily summary per Trading account (orders + profit/loss). Used to track bKash-side merchant volume.",
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
    },
  },
  handler: async (input) => {
    try {
      const day = startOfDay(input.date ? String(input.date) : undefined)
      const next = nextDay(day)
      const rows = await db.tradingBkashDailySummary.findMany({
        where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, summaryDate: { gte: day, lt: next } },
        select: {
          id: true,
          tradingAccountId: true,
          tradingAccount: { select: { accountTitle: true, assignedUser: { select: { name: true } } } },
          totalOrders: true,
          totalProfitBdt: true,
          totalLossBdt: true,
          netResultBdt: true,
          notes: true,
        },
      })

      const data = rows.map((r: typeof rows[number]) => ({
        id: r.id,
        accountId: r.tradingAccountId,
        accountTitle: r.tradingAccount?.accountTitle,
        assignedStaff: r.tradingAccount?.assignedUser?.name,
        totalOrders: r.totalOrders,
        profitBdt: numberFromDecimal(r.totalProfitBdt),
        lossBdt: numberFromDecimal(r.totalLossBdt),
        netBdt: numberFromDecimal(r.netResultBdt),
        notes: r.notes,
      }))

      return {
        success: true,
        data: {
          date: day.toISOString().slice(0, 10),
          totals: {
            orders: data.reduce((s: number, r: { totalOrders: number }) => s + r.totalOrders, 0),
            profit: data.reduce((s: number, r: { profitBdt: number }) => s + r.profitBdt, 0),
            loss: data.reduce((s: number, r: { lossBdt: number }) => s + r.lossBdt, 0),
            net: data.reduce((s: number, r: { netBdt: number }) => s + r.netBdt, 0),
          },
          rows: data,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── list_trading_telegram_drafts ─────────────────────────────────────────────

const list_trading_telegram_drafts: AgentTool = {
  name: 'list_trading_telegram_drafts',
  description:
    'Lists pending/recent trade drafts submitted via the Trading Telegram bot (READ-ONLY — does not post). Use to surface unprocessed staff submissions for owner awareness.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['PENDING', 'POSTED', 'REJECTED', 'PARSE_ERROR', 'ALL'],
        description: 'Filter (default PENDING)',
      },
      limit: { type: 'number', description: 'Max rows (default 20, max 50)' },
    },
  },
  handler: async (input) => {
    try {
      const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50)
      const status = String(input.status ?? 'PENDING')
      const where: Record<string, unknown> = { businessId: TRADING_BUSINESS_ID, isArchived: false }
      if (status !== 'ALL') where.status = status

      const drafts = await db.tradingTelegramDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          status: true,
          telegramUsername: true,
          telegramFirstName: true,
          user: { select: { name: true } },
          tradingAccount: { select: { accountTitle: true } },
          accountAlias: true,
          rawMessage: true,
          tradeType: true,
          usdtAmount: true,
          bdtRate: true,
          parseError: true,
          createdAt: true,
        },
      })

      const rows = drafts.map((d: typeof drafts[number]) => ({
        id: d.id,
        status: d.status,
        from: d.user?.name ?? d.telegramFirstName ?? d.telegramUsername,
        account: d.tradingAccount?.accountTitle ?? d.accountAlias,
        rawMessage: d.rawMessage,
        tradeType: d.tradeType,
        usdtAmount: d.usdtAmount != null ? numberFromDecimal(d.usdtAmount) : null,
        bdtRate: d.bdtRate != null ? numberFromDecimal(d.bdtRate) : null,
        parseError: d.parseError,
        createdAt: d.createdAt.toISOString(),
      }))

      return {
        success: true,
        data: {
          count: rows.length,
          drafts: rows,
          note: 'এই tool শুধু drafts দেখায় — Trading webhook flow ই process করে। Agent process করবে না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Export ───────────────────────────────────────────────────────────────────

export const TRADING_READ_TOOLS: AgentTool[] = [
  get_trading_dashboard,
  get_trading_accounts,
  get_trading_account_detail,
  get_trading_trades_today,
  get_volume_targets,
  get_merchant_progress,
  get_trading_employee_reports,
  get_trading_daily_summary,
  get_trading_bkash_summary,
  list_trading_telegram_drafts,
]

export const TRADING_READ_ROLE_PROMPT = `
## ALMA Trading Read Tools
- get_trading_dashboard: প্রথমে call করুন trading-related যেকোনো প্রশ্নে — full KPI snapshot।
- get_trading_accounts / get_trading_account_detail: account info।
- get_trading_trades_today: আজকের trade list।
- get_volume_targets: per-account daily USDT target + gap।
- get_merchant_progress: merchant goal (account-conversion) progress।
- get_trading_employee_reports: কে আজকের report submit করেছে, কে বাকি।
- get_trading_daily_summary: এক call-এ সব summary (briefing-এর জন্য)।
- get_trading_bkash_summary: bKash side per-account।
- list_trading_telegram_drafts: pending Telegram-জমা drafts (read-only)।
`
