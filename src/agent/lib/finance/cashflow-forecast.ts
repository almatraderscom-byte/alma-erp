/**
 * Phase 4 (finance autonomy) — the CASH-FLOW FORECAST engine.
 *
 * The ERP already REPORTS finance health after the fact (`analyzeFinancials`:
 * revenue, expenses, margins, trends). What it never did was look FORWARD and warn
 * the owner before cash runs short. This module is that look-ahead: it projects a
 * day-by-day cash trajectory from the recent inflow/outflow run-rate plus the dated
 * lumpy obligations (bills + subscription renewals), finds the lowest point, and
 * decides — under the owner's autonomy policy — whether to handle the shortfall
 * alert itself, propose it, or just ask.
 *
 * Honest by construction: there is no reliable single "cash on hand" account in this
 * ERP (the finance ledger tracks person-to-person lending, not a bank balance). So
 * unless the caller passes a known opening balance, the forecast is a NET CASH-FLOW
 * projection starting from 0 — "over the horizon, will the money you generate cover
 * the bills you owe?" — which is a defensible signal even without a bank figure.
 *
 * Safety — mirrors Phases 1-3:
 *   • Pure, deterministic core (`forecastCashFlow`, `buildCashObligations`,
 *     `classifyCashFlowAction`) so it unit-tests cleanly.
 *   • NO money ever moves here. The only autonomous act is RAISING AN ALERT — the
 *     owner decides what to do about it. Money figures use whole-taka `roundMoney`.
 *   • The day-start sweep is a no-op until the master switch is on; even then it only
 *     RECORDS the alert + NOTIFIES the owner. It never pays a bill or transfers funds.
 */
import { roundMoney } from '@/lib/money'
import {
  decideAutonomy,
  getAutonomyPolicy,
  type AutonomyMode,
  type AutonomyPolicy,
} from '@/agent/lib/autonomy-policy'

export const DEFAULT_HORIZON_DAYS = 30
/** Run-rate is read over this trailing window (smooths day-to-day noise). */
export const RUN_RATE_WINDOW_DAYS = 14

export interface CashObligation {
  label: string
  amountTaka: number
  /** Whole days from today until it's due (0 = today). */
  dueInDays: number
}

export interface ForecastInput {
  /** Known opening cash, or null when unknown → forecast is cumulative NET flow from 0. */
  openingCashTaka: number | null
  /** Expected daily money IN (revenue run-rate), whole taka. */
  dailyInflowTaka: number
  /** Expected daily money OUT (operating-expense run-rate), whole taka. */
  dailyOutflowTaka: number
  /** Dated lumpy outflows (bills, subscription renewals) within the horizon. */
  obligations: CashObligation[]
  horizonDays: number
  /** Shortfall is flagged when the projected balance dips below this floor. */
  safetyFloorTaka: number
}

export interface ForecastPoint {
  day: number
  balanceTaka: number
}

export interface CashFlowForecast {
  horizonDays: number
  /** Was an opening balance supplied? false → the numbers are net cumulative flow. */
  openingKnown: boolean
  dailyNetTaka: number
  totalObligationsTaka: number
  endBalanceTaka: number
  lowestBalanceTaka: number
  lowestDay: number
  shortfall: boolean
  /** First day the balance breaches the safety floor (null = never). */
  shortfallDay: number | null
  /** How far below the floor the lowest point sits (>= 0; 0 when no shortfall). */
  shortfallGapTaka: number
  points: ForecastPoint[]
}

/**
 * Project a day-by-day cash trajectory. Pure + deterministic.
 *
 * Each day applies the net run-rate (inflow − outflow), then subtracts any
 * obligations that fall due that day. Day 0 = today's starting balance (the opening,
 * or 0 if unknown) — obligations due "today" (dueInDays <= 0) hit on day 0.
 */
export function forecastCashFlow(input: ForecastInput): CashFlowForecast {
  const horizon = Math.max(1, Math.round(input.horizonDays))
  const opening = input.openingCashTaka == null ? 0 : roundMoney(input.openingCashTaka)
  const dailyNet = roundMoney(input.dailyInflowTaka) - roundMoney(input.dailyOutflowTaka)
  const floor = roundMoney(input.safetyFloorTaka)

  // Bucket obligations by the day they hit (clamp past-due to day 0).
  const dueByDay = new Map<number, number>()
  let totalObligations = 0
  for (const o of input.obligations) {
    const amt = roundMoney(o.amountTaka)
    if (amt <= 0) continue
    const day = Math.max(0, Math.min(horizon, Math.round(o.dueInDays)))
    dueByDay.set(day, (dueByDay.get(day) ?? 0) + amt)
    totalObligations += amt
  }

  const points: ForecastPoint[] = []
  let balance = opening - (dueByDay.get(0) ?? 0)
  points.push({ day: 0, balanceTaka: roundMoney(balance) })

  let lowestBalance = balance
  let lowestDay = 0
  let shortfallDay: number | null = balance < floor ? 0 : null

  for (let day = 1; day <= horizon; day++) {
    balance += dailyNet
    balance -= dueByDay.get(day) ?? 0
    balance = roundMoney(balance)
    points.push({ day, balanceTaka: balance })
    if (balance < lowestBalance) {
      lowestBalance = balance
      lowestDay = day
    }
    if (shortfallDay == null && balance < floor) shortfallDay = day
  }

  const shortfall = shortfallDay != null
  const shortfallGap = shortfall ? Math.max(0, roundMoney(floor - lowestBalance)) : 0

  return {
    horizonDays: horizon,
    openingKnown: input.openingCashTaka != null,
    dailyNetTaka: roundMoney(dailyNet),
    totalObligationsTaka: roundMoney(totalObligations),
    endBalanceTaka: points[points.length - 1].balanceTaka,
    lowestBalanceTaka: roundMoney(lowestBalance),
    lowestDay,
    shortfall,
    shortfallDay,
    shortfallGapTaka: shortfallGap,
    points,
  }
}

// ── Build dated obligations from bills + subscriptions (pure) ───────────────
export interface BillLike {
  name: string
  amount: number
  currency: string
  daysUntil: number | null
}
export interface SubscriptionLike {
  name: string
  amount: number
  currency: string
  /** Days until next renewal (caller computes from nextRenewalAt). */
  daysUntil: number | null
}

export interface BuiltObligations {
  obligations: CashObligation[]
  /** Foreign-currency items left OUT of the BDT forecast, surfaced for transparency. */
  skippedForeign: { label: string; amount: number; currency: string }[]
}

/**
 * Turn tracked bills + subscriptions into dated BDT obligations inside the horizon.
 * Foreign-currency items are deliberately EXCLUDED from the numeric forecast (no
 * guessed FX rate) and returned separately so the owner still sees them.
 */
export function buildCashObligations(input: {
  bills: BillLike[]
  subscriptions: SubscriptionLike[]
  horizonDays: number
}): BuiltObligations {
  const horizon = Math.max(1, Math.round(input.horizonDays))
  const obligations: CashObligation[] = []
  const skippedForeign: { label: string; amount: number; currency: string }[] = []

  const consider = (label: string, amount: number, currency: string, daysUntil: number | null) => {
    const amt = roundMoney(amount)
    if (amt <= 0 || daysUntil == null) return
    if (daysUntil > horizon) return // beyond the window
    if ((currency || 'BDT').toUpperCase() !== 'BDT') {
      skippedForeign.push({ label, amount: amt, currency: currency || '?' })
      return
    }
    obligations.push({ label, amountTaka: amt, dueInDays: Math.max(0, daysUntil) })
  }

  for (const b of input.bills) consider(b.name, b.amount, b.currency, b.daysUntil)
  for (const s of input.subscriptions) consider(s.name, s.amount, s.currency, s.daysUntil)

  return { obligations, skippedForeign }
}

// ── Map a forecast to an autonomy decision (pure) ───────────────────────────
export interface CashFlowAction {
  /** Bangla one-liner for the owner. */
  summary: string
  mode: AutonomyMode
  willAuto: boolean
  reason: string
}

/**
 * A shortfall warning is a FINANCE-category, REVERSIBLE (notify-only, no money moves)
 * action. We run it through the same `decideAutonomy` gate so the owner's policy
 * governs whether the agent proactively alerts (auto), proposes, or just asks.
 * Confidence is modest because run-rate forecasting is inherently uncertain.
 */
export function classifyCashFlowAction(forecast: CashFlowForecast, policy: AutonomyPolicy): CashFlowAction {
  const summary = forecast.shortfall
    ? `সম্ভাব্য নগদ ঘাটতি ${forecast.shortfallDay} দিনে — প্রায় ৳${forecast.shortfallGapTaka} কম পড়তে পারে`
    : 'আগামী মাসে নগদ-প্রবাহ ঠিক আছে বলে মনে হচ্ছে'
  const decision = decideAutonomy(
    { category: 'finance', reversible: true, confidence: 0.65, summary },
    policy,
  )
  return { summary, mode: decision.mode, willAuto: decision.mode === 'auto', reason: decision.reason }
}

// ── Async orchestration ─────────────────────────────────────────────────────
export interface CashFlowScan {
  forecast: CashFlowForecast
  skippedForeign: { label: string; amount: number; currency: string }[]
  revenueWindowTaka: number
  expenseWindowTaka: number
  windowDays: number
}

/**
 * Pull the recent run-rate (analyzeFinancials) + tracked bills/subscriptions, then
 * project the cash trajectory. Read-only; never writes or moves money.
 */
export async function scanCashFlow(opts: { horizonDays?: number; safetyFloorTaka?: number } = {}): Promise<CashFlowScan> {
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS
  const safetyFloorTaka = opts.safetyFloorTaka ?? 0

  const [{ analyzeFinancials }, { listBillsForForecast }, { listSubscriptionsForForecast }] = await Promise.all([
    import('@/lib/financial-intelligence'),
    import('@/agent/lib/finance/forecast-sources'),
    import('@/agent/lib/finance/forecast-sources'),
  ])

  const [health, bills, subscriptions] = await Promise.all([
    analyzeFinancials({ days: RUN_RATE_WINDOW_DAYS }),
    listBillsForForecast(),
    listSubscriptionsForForecast(),
  ])

  const windowDays = health.days || RUN_RATE_WINDOW_DAYS
  const dailyInflowTaka = roundMoney(health.revenue / Math.max(1, windowDays))
  const dailyOutflowTaka = roundMoney(health.expenses.total / Math.max(1, windowDays))

  const { obligations, skippedForeign } = buildCashObligations({ bills, subscriptions, horizonDays })

  const forecast = forecastCashFlow({
    openingCashTaka: null, // no reliable cash-on-hand account → net-flow forecast
    dailyInflowTaka,
    dailyOutflowTaka,
    obligations,
    horizonDays,
    safetyFloorTaka,
  })

  return {
    forecast,
    skippedForeign,
    revenueWindowTaka: roundMoney(health.revenue),
    expenseWindowTaka: roundMoney(health.expenses.total),
    windowDays,
  }
}

export interface CashFlowPlan extends CashFlowScan {
  action: CashFlowAction
  policyEnabled: boolean
}

export async function planCashFlowAutonomy(opts: { horizonDays?: number; safetyFloorTaka?: number } = {}): Promise<CashFlowPlan> {
  const [policy, scan] = await Promise.all([getAutonomyPolicy(), scanCashFlow(opts)])
  const action = classifyCashFlowAction(scan.forecast, policy)
  return { ...scan, action, policyEnabled: policy.enabled }
}

export interface CashFlowSweepResult {
  ran: boolean
  alerted: boolean
  shortfallDay: number | null
  detail: string
}

/**
 * Autonomous day-start cash-flow check. Gated by the master switch (no-op until the
 * owner opts in). SAFE: never moves money — when a shortfall is projected it RECORDS
 * the alert to the autonomy ledger and NOTIFIES the owner. Best-effort; never throws.
 */
export async function runCashFlowSweep(): Promise<CashFlowSweepResult> {
  try {
    const plan = await planCashFlowAutonomy()
    if (!plan.policyEnabled) return { ran: false, alerted: false, shortfallDay: null, detail: 'autonomy_disabled' }
    if (!plan.forecast.shortfall) return { ran: true, alerted: false, shortfallDay: null, detail: 'no_shortfall' }

    const { recordAutonomousAction } = await import('@/agent/lib/autonomy-ledger')
    await recordAutonomousAction({ category: 'finance', summary: plan.action.summary, mode: 'auto' })

    const { notifyOwner } = await import('@/agent/lib/notify-owner')
    await notifyOwner({
      tier: 2,
      title: '💸 নগদ-প্রবাহ সতর্কতা',
      message:
        `${plan.action.summary}\n\n`
        + `(গত ${plan.windowDays} দিনের গড়ে হিসাব · নগদ ব্যালেন্স জানা নেই বলে এটা নিট আয়−খরচ পূর্বাভাস)`,
      category: 'urgent',
    }).catch(() => {})

    return { ran: true, alerted: true, shortfallDay: plan.forecast.shortfallDay, detail: 'alerted' }
  } catch (err) {
    return { ran: false, alerted: false, shortfallDay: null, detail: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
