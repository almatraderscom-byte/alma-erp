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
 * DEEP-work turns (Boss asked for a deep/full/end-to-end job, or the server is
 * driving a delivery contract) also need more rounds than a chat reply: queue
 * the crawl → poll → read the report → read the links → present. At the plain
 * 8-round cap the turn could die mid-contract, and the owner got a progress
 * placeholder instead of the report (incident 2026-07-25). Env-tunable.
 */
export const DEEP_TURN_MAX_ITERATIONS = Math.max(
  Number(process.env.DEEP_TURN_MAX_ITERATIONS) || 60,
  Number(process.env.MAX_TOOL_ITERATIONS) || 8,
)

/**
 * LONG-RUN turns — the answer to the owner's question of 2026-07-26: *"ami jodi
 * tmk claude app e ei same task ta ditam, tmi non-stop 1 hour+ kaj korte paro —
 * amr model keno parche na?"*
 *
 * It was never the model. A turn was capped at MAX_TOOL_ITERATIONS = 8 tool
 * rounds and (by default) 280 seconds, so anything bigger HAD to be broken into
 * Plan-Drive steps. That is why finishing an SEO job needed a whole second
 * engine. A turn Boss has explicitly put in a working mode (plan-drive / a deep
 * "do the whole thing" request) now gets a real working budget instead, and the
 * existing auto-continue chains past even this when a job is genuinely huge.
 *
 * Still bounded: iterations are finite, every tool call still goes through the
 * guard, and the cost ledger records every round.
 */
export const LONG_RUN_TURN_MAX_ITERATIONS = Math.max(
  Number(process.env.LONG_RUN_TURN_MAX_ITERATIONS) || 120,
  Number(process.env.DEEP_TURN_MAX_ITERATIONS) || 60,
)

/**
 * Owner ask 2026-07-26: "ekta part er jnne koyek ta dhap sesh kore amk age update
 * daw, erpor abr onno kaje jaw." A turn may run many tool rounds; without this it
 * speaks once, at the end, and Boss watches a spinner learning nothing.
 *
 * Three rounds is about where a spinner starts to feel dead; four nudges cover a
 * long job without turning the reply into running commentary.
 */
export const PROGRESS_UPDATE_EVERY = Number(process.env.AGENT_PROGRESS_UPDATE_EVERY) || 3
export const MAX_PROGRESS_NUDGES = Number(process.env.AGENT_MAX_PROGRESS_NUDGES) || 4

/**
 * Owner report 2026-08-20 (screenshot: a 61-step ads-manager run, near-total
 * silence after the opening minutes): the flat MAX_PROGRESS_NUDGES=4 was sized
 * for 8-round turns. Browser/deep/long-run turns now run 30/60/120 rounds, so
 * after nudge #4 (~round 12) the head could go silent for a HUNDRED more rounds
 * and the counting rule — the thing that exists because prompt requests never
 * held — silently expired. The cadence must hold for the WHOLE budget: one
 * update owed per PROGRESS_UPDATE_EVERY silent rounds, however long the job.
 * An EXPLICIT AGENT_MAX_PROGRESS_NUDGES stays an absolute cap (an operator
 * setting 1 means 1, not a floor the scaling walks over); only the unset
 * default scales with the budget.
 */
export function maxProgressNudgesFor(maxIterations: number): number {
  const explicit = Number(process.env.AGENT_MAX_PROGRESS_NUDGES)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return Math.max(MAX_PROGRESS_NUDGES, Math.ceil(maxIterations / PROGRESS_UPDATE_EVERY))
}

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

// Vercel PREVIEW auto-enables the opt-in parity flags, so the owner can feel the
// full difference just by opening the preview link. Production
// (VERCEL_ENV==='production') is NEVER affected, and an explicit '<FLAG>=off'
// still wins even on preview.
const IS_VERCEL_PREVIEW = process.env.VERCEL_ENV === 'preview'
const parityFlagOn = (v: string | undefined): boolean => v === 'on' || (IS_VERCEL_PREVIEW && v !== 'off')

// P9 — one shared sampling/output contract across ALL adapters, so the same
// prompt behaves the same everywhere instead of each provider's accidental
// default. OFF in prod unless AGENT_UNIFORM_SAMPLING=on; auto-ON on preview.
export const AGENT_UNIFORM_SAMPLING = parityFlagOn(process.env.AGENT_UNIFORM_SAMPLING)
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
export const AGENT_CONSTITUTION = parityFlagOn(process.env.AGENT_CONSTITUTION)
// Re-inject the compact core rules every N tool ROUNDS within a single long turn
// (context-rot mitigation). Only matters for long turns (browser/agentic).
export const CONSTITUTION_REINJECT_EVERY = Number(process.env.CONSTITUTION_REINJECT_EVERY) || 6

// P3 — plan-first HARD gate: bind make_plan on round 0 for clearly multi-step
// work so a weak head can't tool-spray a complex task. This is product
// behaviour now (the native Codex-style tracker needs the prospective plan),
// so it is ON by default; AGENT_PLAN_GATE=off remains the rollback switch.
export const AGENT_PLAN_GATE = process.env.AGENT_PLAN_GATE !== 'off'
// P2 — ground-before-answer HARD gate: force a tool call on round 0 for a live-
// data question so the model can't answer from memory. OFF by default.
export const AGENT_GROUNDING_GATE = parityFlagOn(process.env.AGENT_GROUNDING_GATE)

// P1 — factual-claim gate: flag a live-data number/status stated with NO
// successful read this turn, so the verifier forces a read or an honest hedge
// (catches fabricated stats the completion-claim ledger check misses). OFF by default.
export const AGENT_FACT_GATE = parityFlagOn(process.env.AGENT_FACT_GATE)

// BP5 — communication STYLE: a calibrated tone/structure module (answer-first,
// plain language, warm-but-professional, structure only when it helps, clear next
// step) with good/bad examples, so the *way* any head talks gets ~70-80% closer
// to the desired feel regardless of model. OFF in prod unless AGENT_STYLE=on;
// auto-ON on preview.
export const AGENT_STYLE = parityFlagOn(process.env.AGENT_STYLE)

// BP6 — robotic-style HARD gate: deterministic detection of unambiguous robotic
// filler ("অবশ্যই! আপনার প্রশ্নের উত্তর হলো…", "চমৎকার প্রশ্ন", "আশা করি সহায়ক",
// emoji spam) that rides the existing verification retry, so tone discipline is
// enforced, not hoped for. OFF in prod unless AGENT_STYLE_GATE=on; auto-ON preview.
export const AGENT_STYLE_GATE = parityFlagOn(process.env.AGENT_STYLE_GATE)

/**
 * ─── UNIVERSAL SERVER-SIDE TOOL SELECTION ───────────────────────────────────
 * One pipeline decides the tool set for EVERY head model (Grok / Gemini / Qwen /
 * DeepSeek / Claude): the model choice changes WHO thinks, never WHICH tools
 * exist. Industry shape (Anthropic Tool Search / Tool RAG): a small relevant
 * pack + a runtime search hop for the long tail.
 * Each flag is an independent kill switch; every one fails back to the exact
 * behaviour that shipped before it.
 */

// Phase 2 — the system prompt is built from the FINAL shipped tool list instead
// of the pre-filter/pre-cap list. Before this, the prompt taught tools the model
// never received (`unknown_tool` calls). ON by default; AGENT_PROMPT_TOOL_TRUTH=off
// restores the old ordering (prompt from the pre-filter list).
export function promptToolTruthEnabled(flag = process.env.AGENT_PROMPT_TOOL_TRUTH): boolean {
  return flag !== 'off'
}

// Phase 3 — refuse to EXECUTE a tool that was not shipped to the model this
// round; answer with a find_tool redirect instead. 'on' enforces, 'shadow' only
// logs the would-be block, 'off' disables. Default: enforce on preview, shadow
// in production until the owner canaries it.
export type ToolMembershipGateMode = 'on' | 'shadow' | 'off'
export function toolMembershipGateMode(
  flag = process.env.AGENT_TOOL_MEMBERSHIP_GATE,
  vercelEnv = process.env.VERCEL_ENV,
): ToolMembershipGateMode {
  if (flag === 'on') return 'on'
  if (flag === 'off') return 'off'
  if (flag === 'shadow') return 'shadow'
  return vercelEnv === 'production' ? 'shadow' : 'on'
}

// Phase 4 — when a provider cap (xAI's 200) forces a trim, keep the RELEVANT
// tools (core + find_tool + the turn's intent packs) instead of blindly slicing
// the array tail, and reserve headroom for find_tool's dynamic loads. ON by
// default (correctness fix); AGENT_RELEVANCE_CAP=off restores the blind slice.
export function relevanceCapEnabled(flag = process.env.AGENT_RELEVANCE_CAP): boolean {
  return flag !== 'off'
}

// Phase 5 — portable JSON-Schema sanitisation on the OpenAI/xAI/OpenRouter path
// (the Gemini path has always sanitised; this one passed raw schemas through).
// OFF in prod unless AGENT_OPENAI_SCHEMA_SANITIZE=on; auto-ON on preview.
export function openAiSchemaSanitizeEnabled(
  flag = process.env.AGENT_OPENAI_SCHEMA_SANITIZE,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  return flag === 'on' || (vercelEnv === 'preview' && flag !== 'off')
}

// Phase 6 — route EVERY head tier (including the Qwen marketing head) through
// the one state router, and make the per-round tool budget a registry property
// instead of a provider check. OFF in prod unless AGENT_UNIVERSAL_TOOL_PIPELINE=on;
// auto-ON on preview.
export function universalToolPipelineEnabled(
  flag = process.env.AGENT_UNIVERSAL_TOOL_PIPELINE,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  return flag === 'on' || (vercelEnv === 'preview' && flag !== 'off')
}

// Phase 7 — specialist sub-agents get a trimmed, role-scoped pack + find_tool
// instead of whole tool groups (base alone is ~103 schemas). OFF in prod unless
// AGENT_SUBAGENT_TOOL_TRIM=on; auto-ON on preview.
export function subagentToolTrimEnabled(
  flag = process.env.AGENT_SUBAGENT_TOOL_TRIM,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  return flag === 'on' || (vercelEnv === 'preview' && flag !== 'off')
}

/**
 * Owner rule 2026-07-25 — SPEAK FIRST, then work (the Claude-app shape).
 * The head must write one spoken line (what it understood + where it will look)
 * BEFORE its first tool call. The blocker was mechanical, not stylistic: the
 * grounding gate set `tool_choice: 'required'` on round 0, which forces the
 * provider to emit a tool call and therefore NO text. With this on, round 0 is
 * left on 'auto' and grounding is enforced AFTER the round instead (one nudge),
 * so the guarantee survives and Boss still gets an instant reply.
 * ON by default; AGENT_SPEAK_FIRST=off restores the forced-tool round 0.
 */
export function speakFirstEnabled(flag = process.env.AGENT_SPEAK_FIRST): boolean {
  return flag !== 'off'
}

/**
 * SK-7 — a pinned skill declaring `isolation: subagent` REPLACES the general
 * behavioural prompt with its own (kernel + alma-base + SYSTEM.md + SKILL.md)
 * instead of being appended to it. This is the owner's original ask; the tool
 * allowlist (SK-4) is the other half and is already live.
 *
 * OFF in production until he has seen it work; auto-ON on preview, which is
 * where SKILL_ENGINE_ENABLED already is.
 */
export function skillIsolationEnabled(
  flag = process.env.AGENT_SKILL_ISOLATION,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  return flag === 'on' || (vercelEnv === 'preview' && flag !== 'off')
}

/**
 * SK-8 — refuse to run a skill nobody approved, or one edited since approval.
 *
 * OFF everywhere unless explicitly `on`, and NOT auto-on for preview like the
 * other flags. Turning this on with an empty ledger disables every skill at
 * once, so the intended order is: run with it off, watch the approval states in
 * the logs, populate the ledger, then switch it on deliberately.
 */
export function skillApprovalGateEnabled(flag = process.env.AGENT_SKILL_APPROVAL_GATE): boolean {
  return flag === 'on'
}

/** Hard ceiling on a trimmed specialist sub-agent's tool count. */
export const SUBAGENT_TOOL_CAP = Number(process.env.SUBAGENT_TOOL_CAP) || 40

/**
 * Phase 6 — tool-round budget for a 'standard' (cheap, worker-grade) head. Only
 * applied when AGENT_UNIVERSAL_TOOL_PIPELINE is on; before it, only the Claude
 * head had a budget and Grok/DeepSeek heads could spree unbounded.
 */
export const STANDARD_HEAD_TOOL_BUDGET = Number(process.env.STANDARD_HEAD_TOOL_BUDGET) || 8

/**
 * The head budgets above are sized for a CHAT reply. A turn the server itself
 * classified as work is a different animal, and mixing the two is what made the
 * owner say "non-stop kaj ekhono hoy na" (2026-07-26).
 *
 * The arithmetic he was up against: a deep-work turn is allowed
 * DEEP_TURN_MAX_ITERATIONS (60) rounds and plan-drive LONG_RUN (120), while the
 * standard head's budget stripped its tools after 8 — and on Vercel PREVIEW,
 * where he tests, AGENT_UNIVERSAL_TOOL_PIPELINE defaults ON, so that 8 was live.
 * The turn did not "decide" to stop; the server took its tools away at round 9.
 *
 * So the budget now follows the turn class. It is still a real ceiling — a chat
 * reply cannot spree — but a job he explicitly started as work gets a budget
 * that matches the work.
 */
export const DEEP_HEAD_TOOL_BUDGET = Number(process.env.DEEP_HEAD_TOOL_BUDGET) || 40
export const LONG_RUN_HEAD_TOOL_BUDGET = Number(process.env.LONG_RUN_HEAD_TOOL_BUDGET) || 100

export type TurnWorkClass = 'chat' | 'deep' | 'long_run'

/** Never smaller than the chat budget — this only ever widens a work turn. */
export function headToolBudgetFor(chatBudget: number, workClass: TurnWorkClass): number {
  if (workClass === 'long_run') return Math.max(chatBudget, LONG_RUN_HEAD_TOOL_BUDGET)
  if (workClass === 'deep') return Math.max(chatBudget, DEEP_HEAD_TOOL_BUDGET)
  return chatBudget
}

/**
 * How many times one turn may push a head that ANNOUNCED the next step and then
 * stopped. One push is right for a chat reply; on a work session it was the
 * difference between finishing and waiting for Boss to type "continue" — which
 * is the whole complaint.
 */
export function maxIntentNudgesFor(workClass: TurnWorkClass): number {
  if (workClass === 'long_run') return Number(process.env.LONG_RUN_INTENT_NUDGES) || 6
  if (workClass === 'deep') return Number(process.env.DEEP_INTENT_NUDGES) || 3
  return 1
}

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
