/**
 * Funding policy — owner-tunable, per-provider operating limits for the Billing
 * Command Center. Stored in agent_kv_settings (no migration, no redeploy), the
 * same pattern as api_balance credits and model routing.
 *
 * A policy only classifies and warns. It authorizes no payment: there is no
 * money-moving code in this module. Roadmap §7.1 (funding tiers) and §7.3
 * (default controls) are the source of these defaults; the owner may override
 * any field at runtime and MUST approve the final tier assignment.
 */
import { prisma } from '@/lib/prisma'
import type { BalanceProviderId } from '@/agent/lib/api-balances'
import type { RunwayThresholds } from '@/agent/lib/billing/runway'

/** Business criticality tier — drives warning aggressiveness and reserve. */
export type FundingCriticality = 'critical' | 'important' | 'variable' | 'free'

/**
 * How a provider is actually funded. Descriptive metadata for the UI, mirroring
 * the capability matrix (roadmap §6). It records the recommended operating mode,
 * not a live capability probe — 'app_top_up' here does NOT enable any charge.
 */
export type FundingMode =
  | 'provider_auto_recharge'
  | 'usage_based_billing'
  | 'postpaid'
  | 'hosted_top_up'
  | 'app_top_up'
  | 'free'
  | 'unsupported'

export type FundingPolicy = {
  providerId: BalanceProviderId
  criticality: FundingCriticality
  fundingMode: FundingMode
  /** Runway (days) at which each alert band trips. */
  warningDays: number
  actionDays: number
  emergencyDays: number
  /** Target headroom the suggested top-up aims for. */
  targetDays: number
  /**
   * Flat wallet floor in USD. A balance below this alerts even when runway can't
   * be computed (idle burn). Preserves the pre-runway alert behaviour.
   */
  minBalanceUsd: number
  /**
   * Owner-set monthly funding ceiling in USD. null → derive 1.5× trailing 30-day
   * spend at runtime (roadmap §7.3).
   */
  monthlyCapUsd: number | null
  /** Whether any funding action must be owner-approved (advisory for now). */
  requiresApproval: boolean
  /** Whether this provider participates in funding monitoring at all. */
  enabled: boolean
}

/** Per-tier threshold presets (roadmap §7.3). */
const TIER_PRESET: Record<FundingCriticality, Omit<FundingPolicy, 'providerId' | 'fundingMode'>> = {
  critical: {
    criticality: 'critical',
    warningDays: 14, actionDays: 7, emergencyDays: 3, targetDays: 30,
    minBalanceUsd: 3, monthlyCapUsd: null, requiresApproval: false, enabled: true,
  },
  important: {
    criticality: 'important',
    warningDays: 10, actionDays: 5, emergencyDays: 2, targetDays: 14,
    minBalanceUsd: 3, monthlyCapUsd: null, requiresApproval: false, enabled: true,
  },
  variable: {
    criticality: 'variable',
    warningDays: 7, actionDays: 3, emergencyDays: 1, targetDays: 14,
    minBalanceUsd: 3, monthlyCapUsd: null, requiresApproval: true, enabled: true,
  },
  free: {
    criticality: 'free',
    warningDays: 0, actionDays: 0, emergencyDays: 0, targetDays: 0,
    minBalanceUsd: 0, monthlyCapUsd: null, requiresApproval: false, enabled: false,
  },
}

/**
 * Default tier + funding mode per provider. These reflect the CURRENT ALMA
 * architecture, which the owner can override:
 * - xAI is 'critical' because the agent head runs on Grok (CLAUDE.md 2026-07).
 * - Telephony (Twilio) and the DeepSeek/Qwen router (OpenRouter) are critical for
 *   owner alerts and customer communication.
 * - Creative/research providers (fal, FASHN, Oxylabs) are 'variable' and
 *   approval-gated because their spend spikes.
 */
const PROVIDER_DEFAULTS: Record<BalanceProviderId, { tier: FundingCriticality; mode: FundingMode; minBalanceUsd?: number }> = {
  anthropic: { tier: 'critical', mode: 'provider_auto_recharge' },
  openai: { tier: 'critical', mode: 'provider_auto_recharge' },
  openrouter: { tier: 'critical', mode: 'provider_auto_recharge' },
  gemini: { tier: 'critical', mode: 'postpaid' },
  google_tts: { tier: 'critical', mode: 'postpaid' },
  // Twilio's prepaid wallet drains fast on calls; keep its historical $5 floor.
  twilio: { tier: 'critical', mode: 'provider_auto_recharge', minBalanceUsd: 5 },
  xai: { tier: 'critical', mode: 'provider_auto_recharge' },
  elevenlabs: { tier: 'important', mode: 'usage_based_billing' },
  vercel: { tier: 'important', mode: 'postpaid' },
  supabase: { tier: 'important', mode: 'postpaid' },
  veo: { tier: 'important', mode: 'postpaid' },
  fal: { tier: 'variable', mode: 'hosted_top_up' },
  fashn: { tier: 'variable', mode: 'provider_auto_recharge' },
  oxylabs: { tier: 'variable', mode: 'hosted_top_up' },
  meta_free: { tier: 'free', mode: 'free' },
}

export const FUNDING_POLICY_KV_KEY = 'billing.funding_policy'

/** Full default policy for one provider (before any owner override). */
export function defaultFundingPolicy(providerId: BalanceProviderId): FundingPolicy {
  const def = PROVIDER_DEFAULTS[providerId] ?? { tier: 'important' as const, mode: 'unsupported' as const }
  const preset = TIER_PRESET[def.tier]
  return {
    ...preset,
    providerId,
    fundingMode: def.mode,
    minBalanceUsd: def.minBalanceUsd ?? preset.minBalanceUsd,
  }
}

export function defaultFundingPolicies(): Record<BalanceProviderId, FundingPolicy> {
  const out = {} as Record<BalanceProviderId, FundingPolicy>
  for (const id of Object.keys(PROVIDER_DEFAULTS) as BalanceProviderId[]) {
    out[id] = defaultFundingPolicy(id)
  }
  return out
}

/** Fields an owner may override. All optional; unset fields keep the default. */
export type FundingPolicyOverride = Partial<Omit<FundingPolicy, 'providerId'>>

/** Merge an override onto a base policy, ignoring non-finite / wrong-typed values. */
export function mergeFundingPolicy(base: FundingPolicy, override?: FundingPolicyOverride): FundingPolicy {
  if (!override) return base
  const merged: FundingPolicy = { ...base }
  const numKeys = ['warningDays', 'actionDays', 'emergencyDays', 'targetDays', 'minBalanceUsd'] as const
  for (const k of numKeys) {
    const v = override[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) merged[k] = v
  }
  if (override.monthlyCapUsd === null) merged.monthlyCapUsd = null
  else if (typeof override.monthlyCapUsd === 'number' && Number.isFinite(override.monthlyCapUsd) && override.monthlyCapUsd >= 0) {
    merged.monthlyCapUsd = override.monthlyCapUsd
  }
  if (override.criticality) merged.criticality = override.criticality
  if (override.fundingMode) merged.fundingMode = override.fundingMode
  if (typeof override.requiresApproval === 'boolean') merged.requiresApproval = override.requiresApproval
  if (typeof override.enabled === 'boolean') merged.enabled = override.enabled
  return merged
}

/** Runway thresholds a runway calc needs, extracted from a policy. */
export function runwayThresholdsFor(policy: FundingPolicy): RunwayThresholds {
  return {
    warningDays: policy.warningDays,
    actionDays: policy.actionDays,
    emergencyDays: policy.emergencyDays,
  }
}

/**
 * Effective monthly funding ceiling: the owner override if set, else 1.5× the
 * trailing 30-day spend, rounded up to a whole dollar (roadmap §7.3). Returns
 * null only when neither is known.
 */
export function effectiveMonthlyCapUsd(policy: FundingPolicy, trailing30dUsd: number | null): number | null {
  if (policy.monthlyCapUsd != null) return policy.monthlyCapUsd
  if (trailing30dUsd != null && Number.isFinite(trailing30dUsd) && trailing30dUsd > 0) {
    return Math.ceil(trailing30dUsd * 1.5)
  }
  return null
}

type StoredOverrides = Partial<Record<BalanceProviderId, FundingPolicyOverride>>

function parseStoredOverrides(raw: string | null | undefined): StoredOverrides {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as StoredOverrides) : {}
  } catch (err) {
    console.warn('[funding-policy] override parse failed:', err instanceof Error ? err.message : err)
    return {}
  }
}

/** Read the full effective policy map (defaults + KV overrides). */
export async function readFundingPolicies(): Promise<Record<BalanceProviderId, FundingPolicy>> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: FUNDING_POLICY_KV_KEY } })
  const overrides = parseStoredOverrides(row?.value)
  const base = defaultFundingPolicies()
  for (const id of Object.keys(base) as BalanceProviderId[]) {
    base[id] = mergeFundingPolicy(base[id], overrides[id])
  }
  return base
}

/** Effective policy for one provider. */
export async function readFundingPolicy(providerId: BalanceProviderId): Promise<FundingPolicy> {
  const all = await readFundingPolicies()
  return all[providerId] ?? defaultFundingPolicy(providerId)
}

/**
 * Persist an owner override for one provider (merged into any existing overrides).
 * Owner-only callers must enforce auth upstream; this is a plain KV write.
 */
export async function setFundingPolicyOverride(
  providerId: BalanceProviderId,
  override: FundingPolicyOverride,
): Promise<void> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: FUNDING_POLICY_KV_KEY } })
  const overrides = parseStoredOverrides(row?.value)
  overrides[providerId] = { ...overrides[providerId], ...override }
  const value = JSON.stringify(overrides)
  await prisma.agentKvSetting.upsert({
    where: { key: FUNDING_POLICY_KV_KEY },
    update: { value },
    create: { key: FUNDING_POLICY_KV_KEY, value },
  })
}
