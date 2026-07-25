/**
 * P10 (behaviour-parity) — the head tool cap, extracted as a pure function so it
 * applies identically whether Grok reaches us via OpenRouter (`x-ai/grok-4.20`)
 * or xAI-direct (`grok-4.20`, provider 'xai'). Both hit xAI's 200-tool limit; the
 * old inline check only matched the OpenRouter slug, silently exposing the
 * xAI-direct head to the "Maximum tools limit reached" 400.
 *
 * Universal pipeline Phase 4 — the cap is no longer a blind `slice(0, cap)`.
 * Array order is registry order, which has nothing to do with the owner's
 * question, so a truncation could (and did) drop exactly the tool the turn
 * needed while keeping unrelated ones. `narrowToolsToCap` keeps the tools that
 * matter (core machinery, find_tool, the turn's intent packs, the workflow's
 * bound tools) and reports every trimmed name so a trim is never silent.
 */
import { AGENT_HEAD_PARITY, relevanceCapEnabled } from '@/agent/config'

export function computeHeadToolCap(model: { apiModel: string; provider: string }): number {
  const isXai = model.apiModel.startsWith('x-ai/') || (AGENT_HEAD_PARITY && model.provider === 'xai')
  return isXai ? 200 : Infinity
}

export interface NarrowToolsOptions {
  /** Names that must survive any trim — core machinery, find_tool, bound tools. */
  keepNames?: readonly string[]
  /** Names the turn's routed packs matched — kept next, after `keepNames`. */
  relevantNames?: readonly string[]
  /**
   * Slots reserved for schemas find_tool may load later in the turn. The static
   * list is capped at `cap - dynamicHeadroom` so a dynamic append can never push
   * the request back over the provider limit (Bug B).
   */
  dynamicHeadroom?: number
}

export interface NarrowedTools<T> {
  tools: T[]
  /** Tool names dropped by the cap — logged in the route span, never silent. */
  trimmed: string[]
  /** Effective static budget after the dynamic headroom reservation. */
  effectiveCap: number
}

/**
 * Pure, order-stable narrowing. Priority: keepNames → relevantNames → the rest
 * in their original order. Within each tier the ORIGINAL array order is
 * preserved, so the emitted schema list stays byte-stable for the prefix cache.
 */
export function narrowToolsToCap<T extends { name: string }>(
  tools: readonly T[],
  cap: number,
  opts: NarrowToolsOptions = {},
): NarrowedTools<T> {
  if (!Number.isFinite(cap)) return { tools: [...tools], trimmed: [], effectiveCap: cap }

  const headroom = Math.max(0, opts.dynamicHeadroom ?? 0)
  const effectiveCap = Math.max(1, cap - headroom)
  if (tools.length <= effectiveCap) return { tools: [...tools], trimmed: [], effectiveCap }

  if (!relevanceCapEnabled()) {
    // Kill switch — the historical blind tail slice.
    return {
      tools: tools.slice(0, effectiveCap),
      trimmed: tools.slice(effectiveCap).map((t) => t.name),
      effectiveCap,
    }
  }

  const keep = new Set(opts.keepNames ?? [])
  const relevant = new Set(opts.relevantNames ?? [])
  const tier = (t: T): number => (keep.has(t.name) ? 0 : relevant.has(t.name) ? 1 : 2)

  const ranked = tools
    .map((t, i) => ({ t, i, tier: tier(t) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)

  const survivorIdx = new Set(ranked.slice(0, effectiveCap).map((r) => r.i))
  const survivors: T[] = []
  const trimmed: string[] = []
  tools.forEach((t, i) => {
    if (survivorIdx.has(i)) survivors.push(t)
    else trimmed.push(t.name)
  })
  return { tools: survivors, trimmed, effectiveCap }
}
