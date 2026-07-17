/**
 * AGENT MODULE — ARCHITECTURE RULE (enforced here, repeat in every agent entry point):
 *
 *   agent code MAY import from ERP shared libs (auth, db client, UI primitives).
 *   ERP code MUST NEVER import from src/agent/.
 *
 * One-way dependency only. Violating this couples the agent to production ERP paths
 * and makes the kill-switch (AGENT_ENABLED) unreliable.
 */

// Kill-switch flag now lives in neutral src/lib so ERP code can honor it without
// importing from src/agent (audit #7). Re-exported here so every agent caller of
// `@/agent/config`'s isAgentEnabled keeps working unchanged.
export { isAgentEnabled } from '@/lib/agent-runtime-flag'

/** Server-only — never expose the key value. */
export const isAnthropicConfigured = () => {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

export const AGENT_MODEL = 'claude-sonnet-4-6'

export const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS) || 8

/**
 * Live-browser turns need far more look→act rounds than ordinary tool turns —
 * a real UI task (Ads Manager, Business Suite) is 15–30 small steps. When a
 * turn starts driving the owner's Chrome (any live_browser_* call), its
 * iteration cap is raised to this value so the task doesn't die silently at
 * MAX_TOOL_ITERATIONS mid-flight (2026-07-12: both WhatsApp-number fix
 * attempts ended at round 8 with no final answer). Env-tunable, no redeploy.
 */
export const BROWSER_TURN_MAX_ITERATIONS = Math.max(
  Number(process.env.BROWSER_TURN_MAX_ITERATIONS) || 30,
  Number(process.env.MAX_TOOL_ITERATIONS) || 8,
)

/**
 * HARD tool-round budget for EXPENSIVE heads (Sonnet, and the Qwen marketing
 * head). After this many tool ROUNDS (model re-invocations that requested tools)
 * the head is forced to stop spree-calling tools and may ONLY hand the rest of
 * the work to a cheap DeepSeek sub-agent (delegate_to_specialist). This is the
 * code-level guarantee — not a prompt suggestion — that an expensive head cannot
 * grind many tools on its own dime. The cheap DeepSeek light head is NOT capped
 * (it is already the cheapest worker, so letting it finish in-line is correct).
 *
 * Rounds, not individual calls: each model turn may request several tools in
 * parallel; what actually costs money is re-invoking the expensive model again
 * with the growing transcript, so we budget those re-invocations.
 */
export const HEAD_TOOL_BUDGET = Number(process.env.HEAD_TOOL_BUDGET) || 2

/**
 * The Qwen MARKETING head is the owner's marketing/Facebook/website specialist —
 * it is meant to do that work itself, in-line, NOT hand it to a cheaper worker
 * (DeepSeek is wrong for marketing quality). So it gets a larger, separate budget:
 * after this many tool ROUNDS it is forced to wrap up and answer (no DeepSeek
 * hand-off), which still stops a runaway spree without crippling a real multi-step
 * marketing job (read page → read history → check website → draft → verify).
 */
export const MARKETING_HEAD_TOOL_BUDGET = Number(process.env.MARKETING_HEAD_TOOL_BUDGET) || 5

/**
 * ─── BEHAVIOUR PARITY LAYER (model-agnostic) ────────────────────────────────
 * Deterministic discipline that applies EQUALLY to whatever head model is
 * selected (Grok / DeepSeek / Gemini / Claude), so the "feel" comes from the
 * harness, not the model. Every flag defaults to the CURRENT behaviour, so
 * merging changes nothing in production until the owner opts in.
 * Full design: docs/BEHAVIOUR_PARITY_LAYER_PLAN.md.
 */

// P9 — one shared sampling/output contract across ALL adapters, so the same
// prompt behaves the same everywhere instead of each provider's accidental
// default. OFF by default (set AGENT_UNIFORM_SAMPLING=on to enable).
export const AGENT_UNIFORM_SAMPLING = process.env.AGENT_UNIFORM_SAMPLING === 'on'
export const GENERATION_DEFAULTS = {
  temperature: Number(process.env.AGENT_TEMPERATURE ?? '0.7'),
  topP: Number(process.env.AGENT_TOP_P ?? '0.95'),
  maxTokens: Number(process.env.AGENT_MAX_TOKENS ?? '8192'),
} as const

// P8 — salvage malformed tool-call JSON args (weak models emit them often)
// instead of passing `{_raw}` into a guaranteed schema failure. Only activates
// ON a parse failure, so it is pure upside; ON by default (set
// AGENT_TOOLCALL_REPAIR=off to restore the raw passthrough).
export const AGENT_TOOLCALL_REPAIR = process.env.AGENT_TOOLCALL_REPAIR !== 'off'

// P10 — apply the same tool cap the OpenRouter path already enforces to the
// xAI-DIRECT head too, so the owner's Grok head never silently carries an
// oversized toolset the xAI API rejects. ON by default (correctness fix; set
// AGENT_HEAD_PARITY=off to restore the slug-only cap).
export const AGENT_HEAD_PARITY = process.env.AGENT_HEAD_PARITY !== 'off'

// P6/P5 — the distilled, always-first CONSTITUTION (one behaviour contract every
// model follows identically) plus in-turn re-injection so a long tool-heavy turn
// doesn't drift from the rules. OFF by default (set AGENT_CONSTITUTION=on).
export const AGENT_CONSTITUTION = process.env.AGENT_CONSTITUTION === 'on'
// Re-inject the compact core rules every N tool ROUNDS within a single long turn
// (context-rot mitigation). Only matters for long turns (browser/agentic).
export const CONSTITUTION_REINJECT_EVERY = Number(process.env.CONSTITUTION_REINJECT_EVERY) || 6

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
