/**
 * AGENT MODULE — ARCHITECTURE RULE (enforced here, repeat in every agent entry point):
 *
 *   agent code MAY import from ERP shared libs (auth, db client, UI primitives).
 *   ERP code MUST NEVER import from src/agent/.
 *
 * One-way dependency only. Violating this couples the agent to production ERP paths
 * and makes the kill-switch (AGENT_ENABLED) unreliable.
 */

export const isAgentEnabled = () => process.env.AGENT_ENABLED === 'true'

/** Server-only — never expose the key value. */
export const isAnthropicConfigured = () => {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

export const AGENT_MODEL = 'claude-sonnet-4-6'

export const MAX_TOOL_ITERATIONS = 8

// Phase prompt specifies budget_tokens values for reference.
// budget_tokens is deprecated on claude-sonnet-4-6; we use thinking: {type:'adaptive'}
// and map to output_config.effort levels instead (off → no thinking param, low → medium, high → high).
export const THINKING_BUDGETS = { off: 0, low: 4000, high: 16000 } as const

// Pricing centralized in pricing.ts (Phase 8)
import { calcAnthropicChatCostUsd, PRICING_META } from '@/agent/lib/pricing'

export const PRICING = {
  inputPerMillion: PRICING_META.anthropic.inputPerMillion,
  outputPerMillion: PRICING_META.anthropic.outputPerMillion,
  cacheWritePerMillion: PRICING_META.anthropic.cacheWritePerMillion,
  cacheReadPerMillion: PRICING_META.anthropic.cacheReadPerMillion,
} as const

export const calcCostUsd = calcAnthropicChatCostUsd
