/**
 * Provider funding runway — how many days a wallet can keep running at the
 * recent burn rate. Pure, side-effect-free forecasting used by the Billing
 * Command Center. Every value produced here is an ESTIMATE derived from locally
 * measured spend, never a provider-confirmed figure.
 *
 * Safety posture (roadmap §7.2): when the data is thin we prefer to UNDERSTATE
 * runway (higher burn / earlier warning) rather than lull the owner into a false
 * sense of headroom. Runway is never reported as infinite, and a null runway
 * means "unknown", not "forever".
 */

/** Spend measured over a trailing window, used to derive a burn rate. */
export type SpendWindow = {
  /** Authoritative-local spend total over the window, in USD. */
  totalUsd: number
  /** Number of distinct calendar days in the window that had any spend. */
  activeDays: number
  /** Calendar length of the window in days (e.g. 7). */
  windowDays: number
}

export type BurnBasis = 'active_days' | 'no_spend'

export type DailyBurn = {
  /** Estimated USD spent per day. 0 only when the window had no spend at all. */
  usdPerDay: number
  basis: BurnBasis
  activeDays: number
  /**
   * False when too few active days back the estimate to trust it. The number is
   * still usable (and deliberately conservative), but the UI must label it rough.
   */
  confident: boolean
}

export type RunwayStatus = 'ok' | 'warning' | 'action' | 'emergency' | 'unknown'

export type Runway = {
  /** Whole days of headroom at the current burn, or null when unknown/idle. */
  days: number | null
  status: RunwayStatus
  confident: boolean
  burnUsdPerDay: number
}

/** Runway classification thresholds, in days. Supplied by the funding policy. */
export type RunwayThresholds = {
  warningDays: number
  actionDays: number
  emergencyDays: number
}

/**
 * Below this many active spend-days, a burn estimate is flagged low-confidence.
 * A single spike day should not read as a trustworthy daily average.
 */
export const MIN_CONFIDENT_ACTIVE_DAYS = 3

/** Round a USD value to whole cents. Forecast display only — never a charge. */
export function roundUsdCents(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Daily burn from a trailing spend window. Averages over ACTIVE days (days that
 * actually had spend), not calendar days — this is the conservative choice: a
 * provider used in bursts gets a higher per-day figure and therefore a shorter,
 * safer runway. Returns a 0/day "no_spend" burn when nothing was spent.
 */
export function computeDailyBurn(window: SpendWindow): DailyBurn {
  const total = Number.isFinite(window.totalUsd) && window.totalUsd > 0 ? window.totalUsd : 0
  const activeDays = Math.max(0, Math.floor(window.activeDays))

  if (total <= 0 || activeDays <= 0) {
    return { usdPerDay: 0, basis: 'no_spend', activeDays, confident: false }
  }

  const usdPerDay = roundUsdCents(total / activeDays)
  return {
    usdPerDay,
    basis: 'active_days',
    activeDays,
    confident: activeDays >= MIN_CONFIDENT_ACTIVE_DAYS,
  }
}

/**
 * Classify a runway length against policy thresholds. A null runway (unknown
 * balance or idle burn) is 'unknown', never a healthy 'ok'.
 */
export function classifyRunway(days: number | null, t: RunwayThresholds): RunwayStatus {
  if (days == null) return 'unknown'
  if (days <= t.emergencyDays) return 'emergency'
  if (days <= t.actionDays) return 'action'
  if (days <= t.warningDays) return 'warning'
  return 'ok'
}

/**
 * Compute runway from a wallet balance and a burn rate.
 *
 * - A null balance (quota / postpaid / no wallet) yields a null, 'unknown' runway.
 * - A zero-or-idle burn yields null — we refuse to render "infinite" headroom as
 *   a certainty (roadmap §7.2 guardrail).
 * - Otherwise days = floor(balance / burn), so we never round headroom up.
 */
export function computeRunway(
  balanceUsd: number | null,
  burn: DailyBurn,
  thresholds: RunwayThresholds,
): Runway {
  if (balanceUsd == null || !Number.isFinite(balanceUsd)) {
    return { days: null, status: 'unknown', confident: false, burnUsdPerDay: burn.usdPerDay }
  }
  if (burn.usdPerDay <= 0) {
    return { days: null, status: 'unknown', confident: false, burnUsdPerDay: 0 }
  }
  const rawDays = balanceUsd / burn.usdPerDay
  const days = Math.max(0, Math.floor(rawDays))
  return {
    days,
    status: classifyRunway(days, thresholds),
    confident: burn.confident,
    burnUsdPerDay: burn.usdPerDay,
  }
}

export type SuggestedTopUp = {
  /** USD to add to reach the target runway, rounded up to the increment. */
  amountUsd: number
  /** True when the raw suggestion was clamped by the monthly cap. */
  cappedByMonthlyMax: boolean
  /** True when there is nothing to suggest (already past target, or unknown burn). */
  none: boolean
}

/**
 * Suggested top-up to reach `targetDays` of runway at the current burn.
 *
 * This is a DISPLAY-ONLY forecast ("to reach ~30 days you'd add about $X"); it
 * moves no money. Guardrails from roadmap §7.2: respect a minimum, round up to a
 * provider increment, and cap by the owner-approved monthly maximum.
 */
export function computeSuggestedTopUp(
  balanceUsd: number | null,
  burn: DailyBurn,
  opts: {
    targetDays: number
    minimumUsd?: number
    incrementUsd?: number
    monthlyMaxUsd?: number | null
    fundedThisMonthUsd?: number
  },
): SuggestedTopUp {
  const none: SuggestedTopUp = { amountUsd: 0, cappedByMonthlyMax: false, none: true }
  if (balanceUsd == null || !Number.isFinite(balanceUsd)) return none
  if (burn.usdPerDay <= 0) return none

  const targetBalance = burn.usdPerDay * Math.max(0, opts.targetDays)
  const rawNeed = targetBalance - balanceUsd
  if (rawNeed <= 0) return none

  const minimum = opts.minimumUsd ?? 0
  const increment = opts.incrementUsd && opts.incrementUsd > 0 ? opts.incrementUsd : 1
  let amount = Math.max(rawNeed, minimum)
  amount = Math.ceil(amount / increment) * increment

  let cappedByMonthlyMax = false
  if (opts.monthlyMaxUsd != null && Number.isFinite(opts.monthlyMaxUsd)) {
    const remainingCap = opts.monthlyMaxUsd - (opts.fundedThisMonthUsd ?? 0)
    if (remainingCap <= 0) return none
    if (amount > remainingCap) {
      amount = remainingCap
      cappedByMonthlyMax = true
    }
  }

  return { amountUsd: roundUsdCents(amount), cappedByMonthlyMax, none: false }
}
