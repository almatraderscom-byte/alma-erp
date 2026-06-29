/**
 * Phase 1 (autonomy foundation) — the AUTONOMY POLICY ENGINE.
 *
 * Everything the agent has shipped so far SURFACES and RECOMMENDS; it rarely ACTS
 * on its own. To safely move toward "the agent just handles it", every would-be
 * autonomous action must first pass through ONE decision point that answers:
 * should I do this myself, propose-and-wait, or always ask the owner?
 *
 * This module is that decision point. `decideAutonomy` is a PURE, deterministic
 * classifier over an action descriptor + the owner's tunable policy; the future
 * action-producing surfaces (CS auto-reply, order confirm/follow-up, reorder,
 * marketing) consult it before doing anything.
 *
 * Safety model — conservative by construction:
 *   • MASTER kill-switch `autonomy_enabled` defaults OFF. Until the owner opts in,
 *     EVERYTHING returns 'ask'. (Mirrors AGENT_AUTODRIVE_ENABLED.)
 *   • MONEY is hard-gated: any spend over the owner's cap → 'ask'; IRREVERSIBLE
 *     spend → always 'ask', cap or no cap. Money decisions never auto-fire here.
 *   • IRREVERSIBLE non-money actions can never be 'auto' — they degrade to 'propose'
 *     at most (owner gets a moment to veto).
 *   • A CONFIDENCE floor downgrades shaky actions (auto→propose→ask).
 *   • Per-category modes default to the cautious end ('propose'/'ask'), never 'auto'.
 *
 * No DB migration — policy lives in agent_kv_settings (owner-tunable, no redeploy).
 * This file is pure logic + a thin KV reader; it performs NO actions itself.
 */
import { prisma } from '@/lib/prisma'

export type AutonomyMode = 'auto' | 'propose' | 'ask'
export type AutonomyCategory =
  | 'cs_reply'
  | 'order_confirm'
  | 'order_followup'
  | 'reorder'
  | 'finance'
  | 'marketing'
  | 'staff_task'
  | 'other'

export const AUTONOMY_CATEGORIES: AutonomyCategory[] = [
  'cs_reply',
  'order_confirm',
  'order_followup',
  'reorder',
  'finance',
  'marketing',
  'staff_task',
  'other',
]

// ── KV keys (owner-tunable, no redeploy) ────────────────────────────────────
export const AUTONOMY_ENABLED_KEY = 'autonomy_enabled'
export const AUTONOMY_MONEY_CAP_KEY = 'autonomy_money_cap_taka'
export const AUTONOMY_CONFIDENCE_MIN_KEY = 'autonomy_confidence_min'
/** Per-category mode override: key = `autonomy_mode:<category>`. */
export const AUTONOMY_MODE_KEY_PREFIX = 'autonomy_mode:'

// ── Conservative defaults (tighten, never loosen, by default) ───────────────
/** Master gate. OFF until the owner explicitly opts in. */
export const DEFAULT_AUTONOMY_ENABLED = false
/** Whole-taka ceiling for an auto-fired spend. 0 = never auto-spend. */
export const DEFAULT_MONEY_CAP_TAKA = 0
/** Below this confidence an action is downgraded one rung. */
export const DEFAULT_CONFIDENCE_MIN = 0.8
/** Default mode per category — none start at 'auto'. */
export const DEFAULT_CATEGORY_MODE: Record<AutonomyCategory, AutonomyMode> = {
  cs_reply: 'propose',
  order_followup: 'propose',
  marketing: 'propose',
  staff_task: 'propose',
  order_confirm: 'ask',
  reorder: 'ask',
  finance: 'ask',
  other: 'ask',
}

export interface AutonomyPolicy {
  enabled: boolean
  moneyCapTaka: number
  confidenceMin: number
  categoryModes: Record<AutonomyCategory, AutonomyMode>
}

export interface ActionDescriptor {
  category: AutonomyCategory
  /** Can this be cleanly undone? Irreversible actions never auto-fire. */
  reversible: boolean
  /** Whole-taka money the action spends/commits (0/undefined = none). */
  moneyTaka?: number
  /** Agent's confidence 0..1 (undefined = treat as fully confident). */
  confidence?: number
  /** Short Bangla description (for the reason / ledger). */
  summary?: string
}

export interface AutonomyDecision {
  mode: AutonomyMode
  /** Owner-facing Bangla explanation of why this mode. */
  reason: string
  riskTier: 'low' | 'medium' | 'high'
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function isMode(v: string): v is AutonomyMode {
  return v === 'auto' || v === 'propose' || v === 'ask'
}

/** One rung more cautious. */
function downgrade(mode: AutonomyMode): AutonomyMode {
  return mode === 'auto' ? 'propose' : mode === 'propose' ? 'ask' : 'ask'
}

/**
 * PURE — given an action and the owner's policy, decide how autonomous to be.
 * Deterministic and side-effect-free, so it unit-tests cleanly.
 */
export function decideAutonomy(action: ActionDescriptor, policy: AutonomyPolicy): AutonomyDecision {
  const money = Math.max(0, Math.round(action.moneyTaka ?? 0))
  const reversible = action.reversible
  const riskTier: AutonomyDecision['riskTier'] = money > 0 || !reversible ? 'high' : 'medium'

  // 0) Master kill-switch — nothing is autonomous until the owner opts in.
  if (!policy.enabled) {
    return { mode: 'ask', reason: 'স্বয়ংক্রিয় মোড এখনো বন্ধ — সব সিদ্ধান্ত আপনাকে জিজ্ঞেস করেই নেব।', riskTier }
  }

  // 1) Money guards — strongest. Irreversible spend always asks; over-cap asks.
  if (money > 0 && !reversible) {
    return { mode: 'ask', reason: `৳${money} খরচ হবে এবং এটা ফেরানো যায় না — তাই অবশ্যই আপনার অনুমতি নেব।`, riskTier: 'high' }
  }
  if (money > policy.moneyCapTaka) {
    return {
      mode: 'ask',
      reason: `৳${money} খরচ — স্বয়ংক্রিয় সীমা ৳${policy.moneyCapTaka}-এর বেশি, তাই আপনার অনুমতি লাগবে।`,
      riskTier: 'high',
    }
  }

  // 2) Base mode from the owner's per-category policy.
  let mode: AutonomyMode = policy.categoryModes[action.category] ?? 'ask'

  // 3) Confidence floor — shaky actions step down one rung.
  const conf = action.confidence === undefined ? 1 : clamp01(action.confidence)
  let lowConfidence = false
  if (conf < policy.confidenceMin && mode !== 'ask') {
    mode = downgrade(mode)
    lowConfidence = true
  }

  // 4) An irreversible (non-money) action may never silently auto-fire.
  let cappedForIrreversible = false
  if (!reversible && mode === 'auto') {
    mode = 'propose'
    cappedForIrreversible = true
  }

  let reason: string
  if (mode === 'auto') {
    reason = 'নিরাপদ ও ফেরানো-যোগ্য কাজ, আপনার নীতিতে অনুমোদিত — নিজে করে ফেলে আপনাকে জানাব।'
  } else if (mode === 'propose') {
    reason = cappedForIrreversible
      ? 'কাজটা সহজে ফেরানো যায় না — তাই করার আগে প্রস্তাব দিয়ে একটু সময় দেব, আপত্তি না থাকলে এগোব।'
      : lowConfidence
        ? 'পুরোপুরি নিশ্চিত নই — তাই প্রস্তাব দিয়ে আপনার সায় নিয়ে এগোব।'
        : 'প্রস্তাব দিয়ে এগোব — আপত্তি না থাকলে করে ফেলব।'
  } else {
    reason = 'এই ধরনের কাজে আপনার নীতি অনুযায়ী সরাসরি অনুমতি নেব।'
  }

  return { mode, reason, riskTier: mode === 'auto' ? 'low' : riskTier }
}

/** Read the owner's current autonomy policy from KV (with safe defaults). */
export async function getAutonomyPolicy(): Promise<AutonomyPolicy> {
  const keys = [
    AUTONOMY_ENABLED_KEY,
    AUTONOMY_MONEY_CAP_KEY,
    AUTONOMY_CONFIDENCE_MIN_KEY,
    ...AUTONOMY_CATEGORIES.map((c) => `${AUTONOMY_MODE_KEY_PREFIX}${c}`),
  ]
  const rows = await prisma.agentKvSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))

  const enabledRaw = byKey.get(AUTONOMY_ENABLED_KEY)
  const enabled = enabledRaw === undefined ? DEFAULT_AUTONOMY_ENABLED : enabledRaw.trim().toLowerCase() === 'true'

  const capRaw = Number(byKey.get(AUTONOMY_MONEY_CAP_KEY))
  const moneyCapTaka = Number.isFinite(capRaw) && capRaw >= 0 ? Math.round(capRaw) : DEFAULT_MONEY_CAP_TAKA

  const confRaw = Number(byKey.get(AUTONOMY_CONFIDENCE_MIN_KEY))
  const confidenceMin = Number.isFinite(confRaw) && confRaw >= 0 && confRaw <= 1 ? confRaw : DEFAULT_CONFIDENCE_MIN

  const categoryModes = { ...DEFAULT_CATEGORY_MODE }
  for (const c of AUTONOMY_CATEGORIES) {
    const v = byKey.get(`${AUTONOMY_MODE_KEY_PREFIX}${c}`)
    if (v && isMode(v.trim())) categoryModes[c] = v.trim() as AutonomyMode
  }

  return { enabled, moneyCapTaka, confidenceMin, categoryModes }
}

/**
 * Convenience: load policy and decide in one call. Used by the action-producing
 * surfaces in later phases. Read-only.
 */
export async function evaluateAction(action: ActionDescriptor): Promise<AutonomyDecision & { policyEnabled: boolean }> {
  const policy = await getAutonomyPolicy()
  const decision = decideAutonomy(action, policy)
  return { ...decision, policyEnabled: policy.enabled }
}
