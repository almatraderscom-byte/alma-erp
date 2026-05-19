import { NextRequest, NextResponse } from 'next/server'
import { Prisma, type TradingCommissionType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getTradingContext, numberFromDecimal, parseTradingDate, TRADING_BUSINESS_ID } from '@/lib/trading'
import { computeWalletSummary } from '@/lib/payroll-wallet'
import { resolveProfileImageForUser } from '@/lib/user-display'

function startOfDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function roleCanManageTradingHr(role: string) {
  return role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'HR'
}

function commissionType(value: unknown): TradingCommissionType {
  const raw = String(value || 'NONE').toUpperCase()
  if (raw === 'PERCENTAGE' || raw === 'FIXED') return raw
  return 'NONE'
}

function money(value: unknown) {
  const n = Number(value || 0)
  return new Prisma.Decimal(Number.isFinite(n) ? n.toFixed(2) : '0')
}

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  if (!roleCanManageTradingHr(ctx.role) && ctx.role !== 'STAFF') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()
  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  const last7 = addDays(today, -6)
  const last30 = addDays(today, -29)
  const userFilter = ctx.isAdmin || ctx.role === 'HR' ? {} : { id: ctx.userId }

  const users = await prisma.user.findMany({
    where: {
      active: true,
      businessAccess: { contains: TRADING_BUSINESS_ID },
      role: { in: ['ADMIN', 'HR', 'STAFF'] },
      ...userFilter,
    },
    include: {
      tradingEmployeeProfile: true,
      assignedTradingAccounts: {
        where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, accountTitle: true, status: true, currentBalance: true, totalProfit: true, totalLoss: true, netRoi: true, merchantProgress: true },
      },
    },
    orderBy: { name: 'asc' },
  })
  const userIds = users.map(u => u.id)
  const employeeIds = users.map(u => u.employeeIdGas).filter(Boolean) as string[]
  const accountIds = users.flatMap(u => u.assignedTradingAccounts.map(a => a.id))

  const [
    tradeGroups,
    snapshotGroups,
    expenseGroups,
    screenshotGroups,
    reportRows,
    ledgerRows,
  ] = await Promise.all([
    userIds.length
      ? prisma.tradingTrade.groupBy({
          by: ['userId'],
          where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, userId: { in: userIds } },
          _count: { _all: true },
          _sum: { netProfit: true, usdtAmount: true },
          _max: { tradeDate: true },
        })
      : Promise.resolve([]),
    accountIds.length
      ? prisma.tradingDailySnapshot.groupBy({
          by: ['tradingAccountId'],
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, date: { gte: last30, lt: tomorrow } },
          _sum: { netResultBdt: true, grossProfitBdt: true, grossLossBdt: true, tradeCount: true },
        })
      : Promise.resolve([]),
    userIds.length
      ? prisma.tradingExpense.groupBy({
          by: ['createdBy'],
          where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, createdBy: { in: userIds }, expenseDate: { gte: last30, lt: tomorrow } },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    userIds.length
      ? prisma.tradingPerformanceScreenshot.groupBy({
          by: ['uploadedBy'],
          where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, uploadedBy: { in: userIds }, shotDate: { gte: last30, lt: tomorrow } },
          _count: { _all: true },
          _max: { shotDate: true },
        })
      : Promise.resolve([]),
    userIds.length
      ? prisma.tradingEmployeeDailyReport.findMany({
          where: { businessId: TRADING_BUSINESS_ID, userId: { in: userIds }, reportDate: { gte: last30, lt: tomorrow } },
          orderBy: { reportDate: 'desc' },
        })
      : Promise.resolve([]),
    employeeIds.length
      ? prisma.employeeLedgerEntry.findMany({
          where: { businessId: TRADING_BUSINESS_ID, employeeId: { in: employeeIds } },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        })
      : Promise.resolve([]),
  ])

  const tradesByUser = new Map(tradeGroups.map(g => [g.userId, g]))
  const expensesByUser = new Map(expenseGroups.map(g => [g.createdBy, g]))
  const screenshotsByUser = new Map(screenshotGroups.map(g => [g.uploadedBy, g]))
  const reportsByUser = new Map<string, typeof reportRows>()
  for (const report of reportRows) {
    const rows = reportsByUser.get(report.userId) ?? []
    rows.push(report)
    reportsByUser.set(report.userId, rows)
  }
  const snapshotsByAccount = new Map(snapshotGroups.map(g => [g.tradingAccountId, g]))
  const walletByEmployee = new Map(employeeIds.map(employeeId => [
    employeeId,
    computeWalletSummary(employeeId, TRADING_BUSINESS_ID, ledgerRows.filter(row => row.employeeId === employeeId)),
  ]))

  const employees = users.map(user => {
    const trade = tradesByUser.get(user.id)
    const expense = expensesByUser.get(user.id)
    const screenshot = screenshotsByUser.get(user.id)
    const reports = reportsByUser.get(user.id) ?? []
    const wallet = user.employeeIdGas ? walletByEmployee.get(user.employeeIdGas) : null
    const accountSnapshots = user.assignedTradingAccounts.map(a => snapshotsByAccount.get(a.id)).filter(Boolean)
    const grossProfit = accountSnapshots.reduce((sum, row) => sum + numberFromDecimal(row?._sum.grossProfitBdt), 0)
    const grossLoss = accountSnapshots.reduce((sum, row) => sum + numberFromDecimal(row?._sum.grossLossBdt), 0)
    const netResult = accountSnapshots.reduce((sum, row) => sum + numberFromDecimal(row?._sum.netResultBdt), 0)
    const totalTrades = Number(trade?._count._all || 0)
    const activityDays = new Set([
      ...reports.map(r => r.reportDate.toISOString().slice(0, 10)),
      ...(trade?._max.tradeDate ? [trade._max.tradeDate.toISOString().slice(0, 10)] : []),
      ...(screenshot?._max.shotDate ? [screenshot._max.shotDate.toISOString().slice(0, 10)] : []),
    ]).size
    const todayReport = reports.some(r => r.reportDate >= today && r.reportDate < tomorrow)
    const lastActiveAt = [
      user.tradingEmployeeProfile?.lastActiveAt,
      trade?._max.tradeDate,
      screenshot?._max.shotDate,
      reports[0]?.submittedAt,
    ].filter(Boolean).sort((a, b) => new Date(b as Date).getTime() - new Date(a as Date).getTime())[0] as Date | undefined
    const inactiveDays = lastActiveAt ? Math.floor((today.getTime() - startOfDay(lastActiveAt).getTime()) / 86_400_000) : 999

    return {
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        joiningDate: user.joiningDate,
        employeeIdGas: user.employeeIdGas,
        salaryHint: user.salaryHint,
        profileImageUrl: resolveProfileImageForUser(user),
      },
      profile: user.tradingEmployeeProfile,
      assignedAccounts: user.assignedTradingAccounts.map(a => ({
        id: a.id,
        accountTitle: a.accountTitle,
        status: a.status,
        currentBalance: numberFromDecimal(a.currentBalance),
        netRoi: numberFromDecimal(a.netRoi),
        merchantProgress: numberFromDecimal(a.merchantProgress),
      })),
      metrics: {
        totalAccountsManaged: user.assignedTradingAccounts.length,
        activeAccounts: user.assignedTradingAccounts.filter(a => a.status === 'ACTIVE').length,
        totalTrades,
        totalTradedUsdt: numberFromDecimal(trade?._sum.usdtAmount),
        totalProfitGenerated: grossProfit,
        totalLosses: grossLoss,
        netResult,
        roiContribution: user.assignedTradingAccounts.length ? user.assignedTradingAccounts.reduce((sum, a) => sum + numberFromDecimal(a.netRoi), 0) / user.assignedTradingAccounts.length : 0,
        merchantGrowthSuccess: user.assignedTradingAccounts.length ? user.assignedTradingAccounts.reduce((sum, a) => sum + numberFromDecimal(a.merchantProgress), 0) / user.assignedTradingAccounts.length : 0,
        activityConsistency: Math.min(100, (activityDays / 30) * 100),
        screenshotConsistency: Math.min(100, (Number(screenshot?._count._all || 0) / 30) * 100),
        reportConsistency: Math.min(100, (reports.length / 30) * 100),
        expensesManaged: numberFromDecimal(expense?._sum.amount),
        lastActiveAt: lastActiveAt?.toISOString() ?? null,
        inactiveDays,
        todayReportSubmitted: todayReport,
      },
      wallet,
    }
  })

  const alerts = employees.flatMap(employee => {
    const out: Array<{ severity: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'; type: string; userId: string; title: string; message: string }> = []
    if (!employee.metrics.todayReportSubmitted) {
      out.push({ severity: 'HIGH', type: 'MISSING_REPORT', userId: employee.user.id, title: 'Missing daily report', message: `${employee.user.name} has not submitted today's trading HR report.` })
    }
    if (employee.metrics.inactiveDays >= 3) {
      out.push({ severity: 'HIGH', type: 'INACTIVITY', userId: employee.user.id, title: 'Trading staff inactive', message: `${employee.user.name} has no recent trade/report/screenshot activity for ${employee.metrics.inactiveDays} days.` })
    }
    if (employee.metrics.totalLosses > employee.metrics.totalProfitGenerated && employee.metrics.totalLosses > 0) {
      out.push({ severity: 'CRITICAL', type: 'EXCESSIVE_LOSS', userId: employee.user.id, title: 'Loss ratio alert', message: `${employee.user.name} has losses above profit in the last 30 days.` })
    }
    if (employee.metrics.activeAccounts > 0 && employee.metrics.screenshotConsistency === 0) {
      out.push({ severity: 'NORMAL', type: 'MISSING_SCREENSHOT', userId: employee.user.id, title: 'Missing screenshots', message: `${employee.user.name} has active accounts but no screenshots in the last 30 days.` })
    }
    return out
  })

  const rankings = {
    topTrader: [...employees].sort((a, b) => b.metrics.totalTrades - a.metrics.totalTrades).slice(0, 5),
    mostProfitable: [...employees].sort((a, b) => b.metrics.netResult - a.metrics.netResult).slice(0, 5),
    lowestLossRatio: [...employees].sort((a, b) => (a.metrics.totalLosses / Math.max(1, a.metrics.totalProfitGenerated)) - (b.metrics.totalLosses / Math.max(1, b.metrics.totalProfitGenerated))).slice(0, 5),
    bestMerchantGrowth: [...employees].sort((a, b) => b.metrics.merchantGrowthSuccess - a.metrics.merchantGrowthSuccess).slice(0, 5),
    mostActive: [...employees].sort((a, b) => b.metrics.activityConsistency - a.metrics.activityConsistency).slice(0, 5),
  }

  return NextResponse.json({
    employees,
    alerts,
    rankings,
    kpis: {
      totalEmployees: employees.length,
      activeEmployees: employees.filter(e => e.profile?.status !== 'INACTIVE').length,
      totalManagedAccounts: employees.reduce((sum, e) => sum + e.metrics.totalAccountsManaged, 0),
      totalProfitGenerated: employees.reduce((sum, e) => sum + e.metrics.totalProfitGenerated, 0),
      totalLosses: employees.reduce((sum, e) => sum + e.metrics.totalLosses, 0),
      totalCommissions: employees.reduce((sum, e) => sum + (e.wallet?.totalCommissions ?? 0), 0),
      totalWalletBalance: employees.reduce((sum, e) => sum + (e.wallet?.currentBalance ?? 0), 0),
      missingReports: alerts.filter(a => a.type === 'MISSING_REPORT').length,
    },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  if (!roleCanManageTradingHr(ctx.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const userId = String(body.userId || body.user_id || '').trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, businessAccess: true, employeeIdGas: true, salaryHint: true } })
  if (!user || !user.businessAccess.includes(TRADING_BUSINESS_ID)) {
    return NextResponse.json({ error: 'Selected user is not an ALMA Trading employee.' }, { status: 400 })
  }
  if (user.role === 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System owner accounts do not use Trading employee profiles.' }, { status: 400 })
  }
  const joiningDate = body.joiningDate ? parseTradingDate(body.joiningDate, 'joiningDate') : null
  if (joiningDate instanceof NextResponse) return joiningDate

  const profile = await prisma.tradingEmployeeProfile.upsert({
    where: { userId },
    create: {
      businessId: TRADING_BUSINESS_ID,
      userId,
      employeeIdGas: String(body.employeeIdGas || user.employeeIdGas || '').trim() || null,
      roleTitle: String(body.roleTitle || body.role || '').trim() || null,
      shift: String(body.shift || 'DAY').toUpperCase(),
      status: String(body.status || 'ACTIVE').toUpperCase(),
      salary: money(body.salary ?? user.salaryHint ?? 0),
      commissionType: commissionType(body.commissionType),
      commissionRate: money(body.commissionRate || 0),
      fixedCommission: money(body.fixedCommission || 0),
      merchantCompletionBonus: money(body.merchantCompletionBonus || 0),
      milestoneBonus: money(body.milestoneBonus || 0),
      notes: String(body.notes || '').trim() || null,
      lastActiveAt: joiningDate || undefined,
    },
    update: {
      employeeIdGas: String(body.employeeIdGas || user.employeeIdGas || '').trim() || null,
      roleTitle: String(body.roleTitle || body.role || '').trim() || null,
      shift: String(body.shift || 'DAY').toUpperCase(),
      status: String(body.status || 'ACTIVE').toUpperCase(),
      salary: money(body.salary ?? user.salaryHint ?? 0),
      commissionType: commissionType(body.commissionType),
      commissionRate: money(body.commissionRate || 0),
      fixedCommission: money(body.fixedCommission || 0),
      merchantCompletionBonus: money(body.merchantCompletionBonus || 0),
      milestoneBonus: money(body.milestoneBonus || 0),
      notes: String(body.notes || '').trim() || null,
      lastActiveAt: joiningDate || undefined,
    },
  })
  await prisma.user.update({
    where: { id: userId },
    data: {
      employeeIdGas: profile.employeeIdGas || undefined,
      salaryHint: profile.salary,
      joiningDate: joiningDate || undefined,
    },
  })
  return NextResponse.json({ ok: true, profile })
}
