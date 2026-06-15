import { DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import { AGENT_MODEL } from '@/agent/config'

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
