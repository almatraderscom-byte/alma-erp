/**
 * Plan-Driver configuration — the safety rails for the autonomous
 * "pursue-until-completion" engine.
 *
 * Two layers, by deliberate design:
 *   1. KILL-SWITCH (env `AGENT_AUTODRIVE_ENABLED`, default OFF) — like AGENT_ENABLED
 *      / SCHEDULERS_ENABLED. When off, the driver does nothing at all. This is the
 *      hard master gate; it needs a deploy/env change to flip, so it can't be
 *      toggled by accident from the owner UI.
 *   2. OWNER-TUNABLE LIMITS (agent_kv_settings, no redeploy) — daily + per-plan
 *      cost caps, max attempts, batch size, and the completion-gate model. These
 *      are the dials the owner adjusts live once autodrive is on.
 *
 * Phase A note: even with the kill-switch ON, the driver only runs in SHADOW /
 * dry-run mode (it logs what it WOULD do and mutates nothing). Real step execution
 * + the completion gate arrive in Phase B/C.
 *
 * Owner decision (recorded): the completion gate starts on DeepSeek under a tight
 * cap so we can watch its judgement cheaply, then move it to Claude if its done/
 * not-done calls aren't reliable. The model id is owner-tunable here — no redeploy.
 */
import { prisma } from '@/lib/prisma'

// ── KV keys (owner-tunable via agent_kv_settings) ───────────────────────────
export const AUTODRIVE_DAILY_CAP_TAKA_KEY = 'autodrive_daily_cap_taka'
export const AUTODRIVE_PLAN_CAP_TAKA_KEY = 'autodrive_plan_cap_taka'
export const AUTODRIVE_MAX_ATTEMPTS_KEY = 'autodrive_max_attempts'
export const AUTODRIVE_BATCH_SIZE_KEY = 'autodrive_batch_size'
export const AUTODRIVE_GATE_MODEL_KEY = 'autodrive_gate_model'

// ── Defaults (conservative — tighten, never loosen, by default) ─────────────
/** Whole-taka cap on TOTAL autodrive spend per day. 0 disables (= hard stop). */
export const DEFAULT_AUTODRIVE_DAILY_CAP_TAKA = 200
/** Whole-taka cap on a SINGLE plan's autodrive spend. */
export const DEFAULT_AUTODRIVE_PLAN_CAP_TAKA = 50
/** Per-plan drive-attempt ceiling before the driver escalates to the owner. */
export const DEFAULT_AUTODRIVE_MAX_ATTEMPTS = 5
/** How many plans a single tick may consider. */
export const DEFAULT_AUTODRIVE_BATCH_SIZE = 10
/**
 * Completion-gate model. Owner choice: start on DeepSeek under a tight cap,
 * validate its judgement, then move to Claude (`claude-sonnet-4-6`) if needed.
 */
export const DEFAULT_AUTODRIVE_GATE_MODEL = 'or-deepseek-v4-flash'

export interface AutodriveConfig {
  /** Hard master gate (env). When false the driver is fully inert. */
  enabled: boolean
  dailyCapTaka: number
  planCapTaka: number
  maxAttempts: number
  batchSize: number
  gateModel: string
}

/**
 * The env kill-switch. Mirrors AGENT_ENABLED / SCHEDULERS_ENABLED semantics:
 * strictly opt-in — anything other than the literal 'true' means OFF.
 */
export function isAutodriveEnabled(): boolean {
  return process.env.AGENT_AUTODRIVE_ENABLED === 'true'
}

function parseIntSetting(value: string | null | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value === '') return fallback
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

/**
 * Load the full config: env kill-switch + owner-tunable KV limits.
 * One DB round-trip (batched), all values clamped to safe ranges.
 */
export async function getAutodriveConfig(): Promise<AutodriveConfig> {
  const rows = await prisma.agentKvSetting.findMany({
    where: {
      key: {
        in: [
          AUTODRIVE_DAILY_CAP_TAKA_KEY,
          AUTODRIVE_PLAN_CAP_TAKA_KEY,
          AUTODRIVE_MAX_ATTEMPTS_KEY,
          AUTODRIVE_BATCH_SIZE_KEY,
          AUTODRIVE_GATE_MODEL_KEY,
        ],
      },
    },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))

  const gateModel = byKey.get(AUTODRIVE_GATE_MODEL_KEY)?.trim()

  return {
    enabled: isAutodriveEnabled(),
    dailyCapTaka: parseIntSetting(byKey.get(AUTODRIVE_DAILY_CAP_TAKA_KEY), DEFAULT_AUTODRIVE_DAILY_CAP_TAKA, 0, 100_000),
    planCapTaka: parseIntSetting(byKey.get(AUTODRIVE_PLAN_CAP_TAKA_KEY), DEFAULT_AUTODRIVE_PLAN_CAP_TAKA, 0, 100_000),
    maxAttempts: parseIntSetting(byKey.get(AUTODRIVE_MAX_ATTEMPTS_KEY), DEFAULT_AUTODRIVE_MAX_ATTEMPTS, 1, 50),
    batchSize: parseIntSetting(byKey.get(AUTODRIVE_BATCH_SIZE_KEY), DEFAULT_AUTODRIVE_BATCH_SIZE, 1, 100),
    gateModel: gateModel && gateModel.length > 0 ? gateModel : DEFAULT_AUTODRIVE_GATE_MODEL,
  }
}

/**
 * Sum of whole-taka autodrive spend across all plans driven today (Asia/Dhaka).
 * The driver uses this against dailyCapTaka before doing any paid work.
 */
export async function getTodayAutodriveSpendTaka(now = new Date()): Promise<number> {
  // Day boundary in Asia/Dhaka (UTC+6), expressed back in UTC for the query.
  const dhakaMs = now.getTime() + 6 * 60 * 60 * 1000
  const dhakaDayStart = new Date(Math.floor(dhakaMs / 86_400_000) * 86_400_000)
  const utcDayStart = new Date(dhakaDayStart.getTime() - 6 * 60 * 60 * 1000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const agg = await db.agentPlan.aggregate({
    _sum: { costTaka: true },
    where: { lastDrivenAt: { gte: utcDayStart } },
  })
  return agg?._sum?.costTaka ?? 0
}
