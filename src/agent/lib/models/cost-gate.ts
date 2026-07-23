/**
 * Cost Governor pre-authorization gate (audit P0-2).
 *
 * Every provider chat call — head, workers, CS, office, graph — flows through
 * `adapterFor()`, and this gate is checked there BEFORE any network/model
 * execution. It provides the two deterministic stops the audit requires:
 *
 *  1. Kill switch: `cost.killSwitch = on` in agent_kv_settings stops ALL paid
 *     model calls immediately — owner-tunable at runtime, NO redeploy needed
 *     (env vars can't do this on Vercel; the KV store can).
 *  2. Hard budget stop: when today's / this month's billable spend has reached
 *     the owner's `cost.budget.dailyUsd` / `cost.budget.monthlyUsd` caps, paid
 *     calls stop deterministically instead of observing the overrun after the
 *     fact. (Budget alerts remain; this adds pre-execution authority.)
 *
 * Availability trade-off (deliberate, matches every owner-settings read in this
 * repo): a STORE failure fails OPEN — a Supabase hiccup must never brick the
 * live agent. The budget decision itself, once readable, is a hard fail-closed
 * stop. Reads are cached ~30s so the gate adds at most one cheap query burst
 * per window, not one per token.
 */
import { prisma } from '@/lib/prisma'
import { queryBillableCostSumBetween } from '@/agent/lib/cost-budget'
import { getBudgetSettings } from '@/agent/lib/cost-events'

export const COST_KILL_SWITCH_KEY = 'cost.killSwitch'

export interface CostGateDecision {
  allow: boolean
  reason?: 'kill_switch' | 'daily_budget' | 'monthly_budget'
  spentUsd?: number
  capUsd?: number
}

interface GateSnapshot {
  killSwitch: boolean
  dailyUsd: number | null
  monthlyUsd: number | null
  todaySpendUsd: number
  monthSpendUsd: number
  at: number
}

const CACHE_MS = 30_000
let cached: GateSnapshot | null = null

/** Test hook. */
export function clearCostGateCache(): void {
  cached = null
}

function dhakaDayBounds(now: Date): { dayStart: Date; monthStart: Date; end: Date } {
  // Asia/Dhaka is UTC+6 with no DST.
  const dhaka = new Date(now.getTime() + 6 * 3600_000)
  const y = dhaka.getUTCFullYear()
  const m = dhaka.getUTCMonth()
  const d = dhaka.getUTCDate()
  const dayStart = new Date(Date.UTC(y, m, d) - 6 * 3600_000)
  const monthStart = new Date(Date.UTC(y, m, 1) - 6 * 3600_000)
  return { dayStart, monthStart, end: now }
}

async function readSnapshot(now: Date): Promise<GateSnapshot> {
  const { dayStart, monthStart, end } = dhakaDayBounds(now)
  const [killRow, budgets, todaySpendUsd, monthSpendUsd] = await Promise.all([
    prisma.agentKvSetting.findUnique({ where: { key: COST_KILL_SWITCH_KEY } }),
    getBudgetSettings(),
    queryBillableCostSumBetween(dayStart, end),
    queryBillableCostSumBetween(monthStart, end),
  ])
  const kill = (killRow?.value ?? '').trim().toLowerCase()
  return {
    killSwitch: kill === 'on' || kill === '1' || kill === 'true',
    dailyUsd: budgets.dailyUsd,
    monthlyUsd: budgets.monthlyUsd,
    todaySpendUsd,
    monthSpendUsd,
    at: now.getTime(),
  }
}

/** Pure decision core — deterministic and unit-tested. */
export function decideCostGate(s: Omit<GateSnapshot, 'at'>): CostGateDecision {
  if (s.killSwitch) return { allow: false, reason: 'kill_switch' }
  if (s.dailyUsd !== null && s.dailyUsd > 0 && s.todaySpendUsd >= s.dailyUsd) {
    return { allow: false, reason: 'daily_budget', spentUsd: s.todaySpendUsd, capUsd: s.dailyUsd }
  }
  if (s.monthlyUsd !== null && s.monthlyUsd > 0 && s.monthSpendUsd >= s.monthlyUsd) {
    return { allow: false, reason: 'monthly_budget', spentUsd: s.monthSpendUsd, capUsd: s.monthlyUsd }
  }
  return { allow: true }
}

/** The live gate used by the adapter seam. */
export async function costGatePreAuth(now: Date = new Date()): Promise<CostGateDecision> {
  try {
    if (!cached || now.getTime() - cached.at > CACHE_MS) {
      cached = await readSnapshot(now)
    }
    return decideCostGate(cached)
  } catch (err) {
    // Store unreachable — fail open (never brick the live agent on a DB blip).
    console.warn('[cost-gate] read failed open:', err instanceof Error ? err.message : err)
    return { allow: true }
  }
}

/** Owner-facing Bangla message for a blocked call. */
export function costGateMessage(d: CostGateDecision): string {
  switch (d.reason) {
    case 'kill_switch':
      return 'Boss, AI খরচের কিল-সুইচ চালু আছে — সব paid মডেল কল বন্ধ। চালু করতে বললে kill switch off করে দেব।'
    case 'daily_budget':
      return `Boss, আজকের AI বাজেট শেষ (খরচ $${(d.spentUsd ?? 0).toFixed(2)} / সীমা $${(d.capUsd ?? 0).toFixed(2)}) — নতুন paid কল বন্ধ রেখেছি। সীমা বাড়াতে চাইলে বলুন।`
    case 'monthly_budget':
      return `Boss, এই মাসের AI বাজেট শেষ (খরচ $${(d.spentUsd ?? 0).toFixed(2)} / সীমা $${(d.capUsd ?? 0).toFixed(2)}) — নতুন paid কল বন্ধ রেখেছি। সীমা বাড়াতে চাইলে বলুন।`
    default:
      return 'Boss, খরচ-নীতির কারণে কলটা আটকানো হয়েছে।'
  }
}
