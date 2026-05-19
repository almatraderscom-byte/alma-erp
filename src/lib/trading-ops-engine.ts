import { isPastScreenshotCutoff, screenshotUploadedToday } from '@/lib/trading-compliance'

export type TradingHealthStatus = 'PROFITABLE' | 'STABLE' | 'RISK' | 'LOSS'
export type TradingAlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type MerchantGrowthTrend = 'UP' | 'DOWN' | 'FLAT'

export type TradingOpsSnapshot = {
  date: Date
  tradeCount: number
  netResultBdt: number
  grossProfitBdt: number
  grossLossBdt: number
  feeBdt: number
  expenseBdt: number
}

export type TradingOpsAssessmentInput = {
  accountId: string
  accountTitle: string
  currentBalance: number
  startingCapital: number
  totalProfit: number
  totalLoss: number
  totalFees: number
  totalExpenses: number
  merchantProgress: number
  snapshots: TradingOpsSnapshot[]
  lastActivityAt?: Date | null
  lastScreenshotAt?: Date | null
  today?: Date
}

export type TradingOpsAssessment = {
  health: TradingHealthStatus
  expenseRatio: number
  feeBurden: number
  capitalUtilization: number
  lossExposure: number
  inactiveDays: number
  lossStreak: number
  merchantGrowthScore: number
  merchantGrowthTrend: MerchantGrowthTrend
  activityStatus: 'ACTIVE_TODAY' | 'ACTIVE_RECENTLY' | 'INACTIVE'
  alerts: Array<{
    key: string
    severity: TradingAlertSeverity
    title: string
    message: string
  }>
}

const DAY_MS = 24 * 60 * 60 * 1000

export function assessTradingAccountOps(input: TradingOpsAssessmentInput): TradingOpsAssessment {
  const today = startOfDay(input.today ?? new Date())
  const snapshots = [...input.snapshots].sort((a, b) => a.date.getTime() - b.date.getTime())
  const todaySnapshot = snapshots.find(row => sameDay(row.date, today))
  const last7 = snapshots.filter(row => row.date >= addDays(today, -6))
  const prev7 = snapshots.filter(row => row.date >= addDays(today, -13) && row.date < addDays(today, -6))
  const weeklyNet = sum(last7, 'netResultBdt')
  const previousWeeklyNet = sum(prev7, 'netResultBdt')
  const todayNet = todaySnapshot?.netResultBdt ?? 0
  const grossResult = Math.abs(input.totalProfit - input.totalLoss)
  const expenseRatio = ratio(input.totalExpenses, Math.max(1, input.totalProfit + input.totalExpenses))
  const feeBurden = ratio(input.totalFees, Math.max(1, grossResult + input.totalFees))
  const capitalUtilization = input.startingCapital > 0 ? Math.max(0, Math.min(100, ((input.startingCapital - input.currentBalance) / input.startingCapital) * 100)) : 0
  const lossExposure = input.startingCapital > 0 ? ratio(input.totalLoss, input.startingCapital) : 0
  const inactiveDays = input.lastActivityAt ? Math.max(0, Math.floor((today.getTime() - startOfDay(input.lastActivityAt).getTime()) / DAY_MS)) : 999
  const screenshotAgeDays = input.lastScreenshotAt ? Math.max(0, Math.floor((today.getTime() - startOfDay(input.lastScreenshotAt).getTime()) / DAY_MS)) : 999
  const lossStreak = consecutiveLossDays(snapshots)
  const activeDays = last7.filter(row => row.tradeCount > 0).length
  const positiveDays = last7.filter(row => row.netResultBdt > 0).length
  const orderGrowth = previousWeeklyNet === 0 ? (weeklyNet > 0 ? 100 : 50) : Math.max(0, Math.min(100, 50 + ((weeklyNet - previousWeeklyNet) / Math.abs(previousWeeklyNet)) * 25))
  const merchantGrowthScore = clamp(
    (activeDays / 7) * 25 +
    (screenshotAgeDays <= 1 ? 20 : screenshotAgeDays <= 3 ? 10 : 0) +
    (weeklyNet > 0 ? 25 : weeklyNet === 0 ? 12 : 0) +
    (positiveDays / 7) * 20 +
    orderGrowth * 0.1,
    0,
    100,
  )
  const merchantGrowthTrend: MerchantGrowthTrend = weeklyNet > previousWeeklyNet * 1.05 ? 'UP' : weeklyNet < previousWeeklyNet * 0.95 ? 'DOWN' : 'FLAT'
  const activityStatus = inactiveDays === 0 ? 'ACTIVE_TODAY' : inactiveDays <= 2 ? 'ACTIVE_RECENTLY' : 'INACTIVE'

  const alerts: TradingOpsAssessment['alerts'] = []
  if (todayNet < -2500) alerts.push(alert(input, 'loss-threshold', 'HIGH', 'Daily loss threshold exceeded', `Today net result is BDT ${Math.round(todayNet).toLocaleString('en-BD')}.`))
  if (inactiveDays >= 3) alerts.push(alert(input, 'inactive-account', 'MEDIUM', 'Trading account inactive', `No trading or Bkash activity for ${inactiveDays} days.`))
  if (expenseRatio >= 35) alerts.push(alert(input, 'expense-ratio', 'HIGH', 'Expense ratio is dangerous', `Expense ratio is ${expenseRatio.toFixed(1)}%.`))
  if (merchantGrowthTrend === 'DOWN' && weeklyNet < 0) alerts.push(alert(input, 'declining-profitability', 'HIGH', 'Profitability is declining', 'This week is trending below the previous week.'))
  if (!todaySnapshot || todaySnapshot.tradeCount === 0) alerts.push(alert(input, 'missing-daily-summary', 'MEDIUM', 'Missing daily activity summary', 'No trade or Bkash summary has been recorded today.'))
  const uploadedToday = screenshotUploadedToday(input.lastScreenshotAt, today)
  if (!uploadedToday && isPastScreenshotCutoff(today)) {
    alerts.push(alert(input, 'missing-screenshot-today', 'HIGH', 'Today\'s screenshot missing', 'Upload today\'s Binance performance screenshot now.'))
  } else if (screenshotAgeDays >= 2) {
    alerts.push(alert(input, 'missing-screenshot', 'MEDIUM', 'No recent performance screenshot', screenshotAgeDays === 999 ? 'No screenshot has been uploaded yet.' : `Last screenshot was ${screenshotAgeDays} days ago.`))
  }
  const criticalBalance = input.currentBalance < 0 || (input.startingCapital > 0 && input.currentBalance <= input.startingCapital * 0.2)
  if (criticalBalance) alerts.push(alert(input, 'critical-balance', 'CRITICAL', 'Account balance critically low', `Current balance is BDT ${Math.round(input.currentBalance).toLocaleString('en-BD')}.`))
  if (lossStreak >= 3) alerts.push(alert(input, 'loss-streak', 'HIGH', 'Loss streak detected', `${lossStreak} consecutive loss days detected.`))

  const health = healthStatus({
    currentBalance: input.currentBalance,
    startingCapital: input.startingCapital,
    weeklyNet,
    todayNet,
    expenseRatio,
    lossStreak,
    inactiveDays,
    merchantGrowthScore,
  })

  return {
    health,
    expenseRatio,
    feeBurden,
    capitalUtilization,
    lossExposure,
    inactiveDays,
    lossStreak,
    merchantGrowthScore,
    merchantGrowthTrend,
    activityStatus,
    alerts,
  }
}

function healthStatus(input: {
  currentBalance: number
  startingCapital: number
  weeklyNet: number
  todayNet: number
  expenseRatio: number
  lossStreak: number
  inactiveDays: number
  merchantGrowthScore: number
}): TradingHealthStatus {
  if (input.currentBalance < 0 || input.weeklyNet < -5000 || input.lossStreak >= 3) return 'LOSS'
  const lowBalanceRisk = input.startingCapital > 0 && input.currentBalance <= input.startingCapital * 0.25
  if (input.todayNet < -1500 || input.expenseRatio >= 35 || input.inactiveDays >= 3 || lowBalanceRisk) return 'RISK'
  if (input.weeklyNet > 0 && input.merchantGrowthScore >= 65 && input.expenseRatio < 25) return 'PROFITABLE'
  return 'STABLE'
}

function alert(input: TradingOpsAssessmentInput, key: string, severity: TradingAlertSeverity, title: string, message: string) {
  return {
    key: `${input.accountId}:${key}`,
    severity,
    title: `${input.accountTitle}: ${title}`,
    message,
  }
}

function consecutiveLossDays(rows: TradingOpsSnapshot[]) {
  let streak = 0
  for (const row of [...rows].sort((a, b) => b.date.getTime() - a.date.getTime())) {
    if (row.netResultBdt < 0) streak += 1
    else if (row.tradeCount > 0 || row.netResultBdt > 0) break
  }
  return streak
}

function sum(rows: TradingOpsSnapshot[], key: keyof Pick<TradingOpsSnapshot, 'netResultBdt' | 'grossProfitBdt' | 'grossLossBdt' | 'feeBdt' | 'expenseBdt'>) {
  return rows.reduce((total, row) => total + row[key], 0)
}

function ratio(value: number, base: number) {
  return base > 0 ? (value / base) * 100 : 0
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function startOfDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function sameDay(a: Date, b: Date) {
  return startOfDay(a).getTime() === startOfDay(b).getTime()
}
