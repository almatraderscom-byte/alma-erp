/**
 * Task-tier model routing — Claude locked for critical paths; OpenRouter for tuktak.
 */
import { getModel, DEFAULT_MODEL_ID, type ModelEntry, isAnthropicModel, isKnownModelId } from '@/agent/lib/models/registry'
import { SPECIALIST_ROLES, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import {
  getModelRoutingConfig,
  type ModelRoutingConfig,
  type TaskTier,
} from '@/agent/lib/models/routing-config'

export type { TaskTier }

/**
 * Finance / data analysis — never cheap, stays on Claude.
 * NOTE: `ops` (staff dispatch + coordination) was intentionally moved OUT of critical per
 * owner decision — staff handling is a small job and now runs on DeepSeek (see ops.preferredModelId
 * in specialist-roles.ts). Finance (`analyst`) remains Claude-guarded.
 */
export const CRITICAL_SPECIALIST_ROLES = new Set<SpecialistRole>(['analyst'])

export function roleToTaskTier(role: SpecialistRole): TaskTier {
  if (CRITICAL_SPECIALIST_ROLES.has(role)) return 'critical'
  if (role === 'researcher' || role === 'marketer' || role === 'content') return 'heavy'
  return 'light'
}

export function resolveModelIdForTier(tier: TaskTier, config: ModelRoutingConfig): string {
  switch (tier) {
    case 'critical':
      return config.criticalSubagentModelId
    case 'heavy':
      return config.heavyModelId
    case 'light':
      return config.lightModelId
    default:
      return DEFAULT_MODEL_ID
  }
}

/** Hard guard — critical paths MUST resolve to Claude. Throws on violation. */
export function assertCriticalTierUsesClaude(modelId: string, tier: TaskTier): void {
  if (tier !== 'critical') return
  if (!isAnthropicModel(modelId)) {
    throw new Error(
      `CRITICAL tier must use Claude — refused ${modelId} (non-anthropic). ` +
        'Fix model.routing.tier.criticalSubagentModelId in KV.',
    )
  }
}

export async function resolveSubagentModel(role: SpecialistRole): Promise<{
  tier: TaskTier
  model: ModelEntry
}> {
  const config = await getModelRoutingConfig()
  const tier = roleToTaskTier(role)
  let modelId = resolveModelIdForTier(tier, config)
  // Honor a role's preferred worker model on NON-critical tiers (e.g. cs/marketer
  // → Qwen) — but ONLY while the router-worker experiment is on, so merging to
  // production with the flags off leaves the current tier-default routing
  // unchanged. Critical tiers always ignore it (Claude, enforced just below).
  const routerExperimentOn =
    process.env.ENABLE_SLIM_ROUTER !== 'false' || process.env.DELEGATION_APPROVAL !== 'false'
  if (tier !== 'critical' && routerExperimentOn) {
    const pref = SPECIALIST_ROLES[role]?.preferredModelId
    if (pref && isKnownModelId(pref)) modelId = pref
  }
  assertCriticalTierUsesClaude(modelId, tier)
  return { tier, model: getModel(modelId) }
}

/** Fallback when OpenRouter errors — cheap tiers use native Gemini before Claude. */
export function fallbackModelForTier(tier: TaskTier, failedModelId: string): ModelEntry | null {
  const failed = getModel(failedModelId)
  if (failed.provider !== 'openrouter') return null

  if (tier === 'light' || tier === 'heavy') {
    const nativeCheap = getModel('gemini-3.1-flash-lite')
    if (nativeCheap.id !== failedModelId) return nativeCheap
  }

  if (tier === 'light') {
    const heavyOr = getModel('or-gemini-2.5-flash-lite')
    if (heavyOr.id !== failedModelId) return heavyOr
  }

  return getModel(DEFAULT_MODEL_ID)
}

export function isOpenRouterProvider(provider: string): boolean {
  return provider === 'openrouter'
}
