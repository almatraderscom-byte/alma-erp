import { DEFAULT_MODEL_ID, isAnthropicModel } from '@/agent/lib/models/registry'
import { AGENT_MODEL } from '@/agent/config'
import type { TaskTier } from '@/agent/lib/models/routing-config'

/**
 * Automated / critical paths (CS, finance, schedulers, salah, claim-verifier internals)
 * must never accept a per-session model override.
 */
export function assertModelOverrideNotAllowed(modelId?: string | null): void {
  if (modelId && modelId !== DEFAULT_MODEL_ID) {
    throw new Error('model override not allowed on automated path')
  }
}

/** Returns the locked Claude model for automated paths; throws if override attempted. */
export function enforceClaudeOnlyModel(modelOverride?: string | null): string {
  assertModelOverrideNotAllowed(modelOverride)
  return AGENT_MODEL
}

/** Router assertion — critical tier must never map to a non-Claude model. */
export function assertRouterCriticalModel(modelId: string, tier: TaskTier): void {
  if (tier !== 'critical') return
  if (!isAnthropicModel(modelId)) {
    throw new Error(`router: critical tier mapped to non-Claude model ${modelId}`)
  }
}
