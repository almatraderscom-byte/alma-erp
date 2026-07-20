/**
 * G09 / SPEC-085 — Capability cost and model-tier metadata.
 *
 * Maps a capability to the model tier the Cost Governor (G04) should authorize
 * for it, and proves the declared tier is CONSISTENT with the real cost drivers
 * of its G08 tools:
 *   - any tool that invokes a generative model  → tier 'heavy',
 *   - any external / high-risk tool             → tier 'standard',
 *   - otherwise                                 → tier 'light'.
 * The cost class must track the tier (light→free, standard→metered, heavy→premium).
 *
 * Deterministic, no LLM (INV-01): tier selection is a fold over declared tool
 * metadata, never a model judgement. It never SELECTS a stronger model — it only
 * declares the ceiling the Cost Governor may authorize (INV-03; no silent upgrade).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { getManifest } from '@/agent/tools/manifests'
import type { SideEffectKind } from '@/agent/tools/manifests/manifest.schema'
import {
  CAPABILITY_TIERS,
  type Capability,
  type CapabilityCostClass,
  type CapabilityTier,
} from './capability.schema'
import { capabilityStore } from './store'

export const COST_TIER_CONTRACT_VERSION = '1.0.0' as const

/** Cost Governor hint per tier: the model class + a soft per-call USD ceiling. */
export interface TierHint {
  modelClass: 'cheap' | 'mid' | 'premium'
  maxUsdPerCall: number
}
export const TIER_HINTS: Record<CapabilityTier, TierHint> = {
  light: { modelClass: 'cheap', maxUsdPerCall: 0.02 },
  standard: { modelClass: 'mid', maxUsdPerCall: 0.15 },
  heavy: { modelClass: 'premium', maxUsdPerCall: 1.5 },
}

const EXTERNAL: ReadonlySet<SideEffectKind> = new Set(['external_message', 'external_api_write', 'money_movement', 'browser_action'])

/** Canonical tier for a set of tool names (skips unknown tools; see checks). */
export function expectedTier(toolNames: readonly string[]): CapabilityTier {
  let heavy = false
  let standard = false
  for (const name of toolNames) {
    const m = getManifest(name)
    if (!m) continue
    if (m.capability.sideEffects.includes('model_invocation')) heavy = true
    if (m.capability.risk === 'high' || m.capability.sideEffects.some((s) => EXTERNAL.has(s))) standard = true
  }
  return heavy ? 'heavy' : standard ? 'standard' : 'light'
}

export function expectedClass(tier: CapabilityTier): CapabilityCostClass {
  return tier === 'heavy' ? 'premium' : tier === 'standard' ? 'metered' : 'free'
}

export function tierHintFor(capability: Capability): TierHint {
  return TIER_HINTS[capability.cost.tier]
}

export interface CostIssue {
  capability: string
  code: 'TIER_MISMATCH' | 'CLASS_MISMATCH' | 'UNKNOWN_TIER'
  detail: string
}

/** Verify a capability's declared tier/class match its tools' real cost drivers. */
export function checkCostMetadata(c: Capability): CostIssue[] {
  const issues: CostIssue[] = []
  if (!(CAPABILITY_TIERS as readonly string[]).includes(c.cost.tier)) {
    issues.push({ capability: c.key, code: 'UNKNOWN_TIER', detail: c.cost.tier })
    return issues
  }
  const exp = expectedTier(c.toolNames)
  if (c.cost.tier !== exp) issues.push({ capability: c.key, code: 'TIER_MISMATCH', detail: `declared=${c.cost.tier} expected=${exp}` })
  if (c.cost.class !== expectedClass(c.cost.tier)) issues.push({ capability: c.key, code: 'CLASS_MISMATCH', detail: `class=${c.cost.class} tier=${c.cost.tier}` })
  return issues
}

export function checkAllCostMetadata(caps: readonly Capability[] = capabilityStore.list()): CostIssue[] {
  return caps.flatMap(checkCostMetadata)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const costRequestSchema = z.union([
  z.object({ kind: z.literal('hint'), capabilityKey: z.string().min(1) }),
  z.object({ kind: z.literal('check'), capabilityKey: z.string().min(1) }),
])
export type CostRequest = z.infer<typeof costRequestSchema>

export type CostResultValue =
  | { kind: 'hint'; tier: CapabilityTier; hint: TierHint }
  | { kind: 'check'; issues: CostIssue[] }

export function queryCostTier(raw: unknown): ComponentResult<CostResultValue> {
  const check = validateRequest(raw, costRequestSchema, COST_TIER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { costTier: COST_TIER_CONTRACT_VERSION }
  const q = check.request.payload
  const cap = capabilityStore.getByKey(q.capabilityKey)
  if (!cap) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  if (q.kind === 'hint') return completed({ kind: 'hint', tier: cap.cost.tier, hint: tierHintFor(cap) }, [], versions)
  return completed({ kind: 'check', issues: checkCostMetadata(cap) }, [], versions)
}
