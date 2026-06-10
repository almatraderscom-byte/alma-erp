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

export const AGENT_MODEL = 'claude-sonnet-4-6'

export const MAX_TOOL_ITERATIONS = 8

// Phase prompt specifies budget_tokens values for reference.
// budget_tokens is deprecated on claude-sonnet-4-6; we use thinking: {type:'adaptive'}
// and map to output_config.effort levels instead (off → no thinking param, low → medium, high → high).
export const THINKING_BUDGETS = { off: 0, low: 4000, high: 16000 } as const

// Pricing: USD per 1M tokens for claude-sonnet-4-6 (verified 2026-06-10).
export const PRICING = {
  inputPerMillion:       3.00,
  outputPerMillion:     15.00,
  cacheWritePerMillion:  3.75,  // 5-min cache write (1.25× base input)
  cacheReadPerMillion:   0.30,  // cache read hit (0.1× base input)
} as const

export function calcCostUsd(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}): number {
  const input      = (usage.input_tokens                    / 1_000_000) * PRICING.inputPerMillion
  const output     = (usage.output_tokens                   / 1_000_000) * PRICING.outputPerMillion
  const cacheWrite = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * PRICING.cacheWritePerMillion
  const cacheRead  = ((usage.cache_read_input_tokens      ?? 0) / 1_000_000) * PRICING.cacheReadPerMillion
  return Math.round((input + output + cacheWrite + cacheRead) * 1_000_000) / 1_000_000
}
