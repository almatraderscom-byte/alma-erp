/**
 * Owner-selectable THINKING LEVEL (reasoning effort) — one neutral scale, mapped
 * onto each provider's real API knob.
 *
 * Owner ask 2026-08-21: "model select-এর ওই জায়গাতেই thinking level দাও, যাতে API
 * থেকে সব মডেলের সাথে perfectly sync হয়ে effort কাজ করে — high / max / normal বেছে
 * কাজ করতে পারি।" Before this, effort was invisible and inconsistent: Claude ran
 * `thinking: {type:'adaptive'}` with no `output_config.effort`, Gemini only asked
 * for `includeThoughts` (no `thinkingLevel`), OpenRouter was hard-coded to
 * `effort: 'medium'`, and raw OpenAI read one env var (LUNA_REASONING_EFFORT) for
 * every chat. So the same "high" question thought at four different depths and
 * the owner had no dial.
 *
 * The scale is neutral (low → medium → high → xhigh → max) and each model
 * declares which levels it ACTUALLY accepts, verified against provider docs on
 * 2026-08-21:
 *
 *  - Anthropic (Opus 4.8 / Sonnet 4.6): `output_config: { effort }`, GA, no beta
 *    header. Opus 4.8 accepts low|medium|high|xhigh|max; Sonnet 4.6 predates
 *    `xhigh`. Haiku 4.5 REJECTS `effort` entirely — it is a pre-4.6 model, so its
 *    depth dial is `thinking: {type:'enabled', budget_tokens:N}` instead.
 *  - Google (Gemini 3.x / 2.5): `generationConfig.thinkingConfig.thinkingLevel`
 *    = minimal|low|medium|high (ai.google.dev/gemini-api/docs/thinking). There is
 *    no level above `high`, so Gemini models do not offer max/xhigh at all.
 *  - OpenAI (Responses API): `reasoning: { effort }`. gpt-5.6 Luna documents
 *    none|low|medium|high|xhigh|max; gpt-5.5 stops at xhigh.
 *  - OpenRouter / xAI: `reasoning: { effort }` — OpenRouter normalizes the same
 *    words onto each host's budget/level dialect and clamps anything the target
 *    model cannot do.
 *
 * Two rules keep this honest:
 *   1. A picker only ever offers levels the model really has (`levels` below), so
 *      "Max" never means "silently high".
 *   2. When an owner-level pick meets a model that lacks it (the Auto head can
 *      land anywhere), `clampEffort` steps DOWN to the nearest supported level —
 *      it never invents a higher one.
 */

/** The neutral scale. `null`/absent = Auto (the model's own default — today's behaviour). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Which provider knob a model's effort rides on. */
export type EffortDialect =
  /** Anthropic 4.6+ — `output_config: { effort }` */
  | 'anthropic_effort'
  /** Anthropic pre-4.6 (Haiku 4.5) — `thinking: { type:'enabled', budget_tokens }` */
  | 'anthropic_budget'
  /** Google — `generationConfig.thinkingConfig.thinkingLevel` */
  | 'gemini_thinking_level'
  /** OpenAI Responses API — `reasoning: { effort }` */
  | 'openai_effort'
  /** OpenRouter / xAI (OpenAI dialect) — `reasoning: { enabled, effort }` */
  | 'openrouter_effort'

export interface EffortSupport {
  dialect: EffortDialect
  /** Levels this model genuinely accepts, ascending. Empty = no dial at all. */
  levels: EffortLevel[]
  /** What the provider does when nothing is sent (documentation, for the UI hint). */
  providerDefault?: EffortLevel
}

const ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (ORDER as string[]).includes(v)
}

/** Accepted as a conversation setting: a real level, or 'auto' (= clear it). */
export function parseEffortSetting(v: unknown): EffortLevel | null | undefined {
  if (v === null) return null
  if (v === 'auto' || v === '') return null
  return isEffortLevel(v) ? v : undefined
}

export function effortRank(level: EffortLevel): number {
  return ORDER.indexOf(level)
}

/**
 * Fit an owner's pick onto one model. Steps DOWN to the nearest supported level
 * (never up), so "Max" on a Gemini head runs Gemini's real ceiling (`high`)
 * instead of a value the API would reject. Returns null when the model has no
 * dial — the caller then sends nothing and the provider default stands.
 */
export function clampEffort(
  requested: EffortLevel | null | undefined,
  support: EffortSupport | undefined,
): EffortLevel | null {
  if (!requested || !support || support.levels.length === 0) return null
  if (support.levels.includes(requested)) return requested
  const wanted = effortRank(requested)
  const below = support.levels.filter((l) => effortRank(l) <= wanted)
  if (below.length > 0) return below[below.length - 1]
  // Requested below everything this model offers → its cheapest level.
  return support.levels[0]
}

/**
 * Anthropic pre-4.6 depth dial. `budget_tokens` MUST be ≥1024 and strictly less
 * than max_tokens, so the budget is derived from the request's own cap instead of
 * a constant that could exceed a small max_tokens and 400 the turn.
 */
export function anthropicThinkingBudget(level: EffortLevel, maxTokens: number): number {
  const share: Record<EffortLevel, number> = {
    low: 0.25,
    medium: 0.5,
    high: 0.75,
    xhigh: 0.85,
    max: 0.9,
  }
  const ceiling = Math.max(1024, maxTokens - 512)
  const budget = Math.floor(maxTokens * share[level])
  return Math.max(1024, Math.min(budget, ceiling))
}

/** Google's thinkingLevel enum. Gemini has nothing above `high`. */
export function geminiThinkingLevel(level: EffortLevel): 'low' | 'medium' | 'high' {
  if (level === 'low') return 'low'
  if (level === 'medium') return 'medium'
  return 'high'
}

/** Owner-facing labels (Bangla chat, English model names — same as the picker). */
export const EFFORT_LABELS: Record<EffortLevel, { en: string; bn: string }> = {
  low: { en: 'Low', bn: 'দ্রুত' },
  medium: { en: 'Normal', bn: 'স্বাভাবিক' },
  high: { en: 'High', bn: 'বেশি' },
  xhigh: { en: 'Extra high', bn: 'আরও বেশি' },
  max: { en: 'Max', bn: 'সর্বোচ্চ' },
}
