/**
 * Versioned context-compiler contract (G05 / SPEC-041).
 *
 * Assembles the model prompt from ordered, typed bundles — a stable cacheable
 * prefix (constitution → skills → policy) followed by dynamic segments (workflow
 * state → memory → tool schema → request suffix). Deterministic: same bundles →
 * same compiled text + token count (uses the G03 estimator). Produces a
 * provenance record so any compiled context is replayable (SPEC-050). No LLM.
 */
import { estimateTokens, heuristicTokenEstimator, type TokenEstimator } from '../finops/tokens';

export const CONTEXT_CONTRACT_VERSION = '1.0.0' as const;

/** Canonical bundle kinds with their fixed assembly order (lower = earlier). */
export const BUNDLE_ORDER = {
  constitution: 10,
  skill: 20,
  policy: 30,
  workflow_state: 40,
  memory: 50,
  tool_schema: 60,
  request_suffix: 100,
} as const;

export type BundleKind = keyof typeof BUNDLE_ORDER;

export interface ContextBundle {
  id: string;
  kind: BundleKind;
  content: string;
  /** cacheable bundles form the stable prefix (prompt caching, G07) */
  cacheable: boolean;
  /** optional explicit version for provenance */
  version?: string;
}

export interface BundleProvenance {
  id: string;
  kind: BundleKind;
  order: number;
  cacheable: boolean;
  tokens: number;
  version: string;
}

export interface CompiledContext {
  text: string;
  totalTokens: number;
  /** tokens in the leading contiguous run of cacheable bundles */
  cacheablePrefixTokens: number;
  provenance: BundleProvenance[];
  contractVersion: string;
}

const SEP = '\n\n';

/**
 * Compile bundles into a single prompt. Bundles are sorted by their kind's fixed
 * order (stable within a kind). Deterministic given the same bundles + estimator.
 */
export function compile(
  bundles: ContextBundle[],
  estimator: TokenEstimator = heuristicTokenEstimator,
): CompiledContext {
  const ordered = [...bundles].sort((a, b) => BUNDLE_ORDER[a.kind] - BUNDLE_ORDER[b.kind]);

  const provenance: BundleProvenance[] = ordered.map((b) => ({
    id: b.id,
    kind: b.kind,
    order: BUNDLE_ORDER[b.kind],
    cacheable: b.cacheable,
    tokens: estimateTokens(b.content, estimator),
    version: b.version ?? '1',
  }));

  const text = ordered.map((b) => b.content).join(SEP);
  const totalTokens = provenance.reduce((s, p) => s + p.tokens, 0);

  // cacheable prefix = leading run of cacheable bundles (breaks at first dynamic)
  let cacheablePrefixTokens = 0;
  for (const p of provenance) {
    if (!p.cacheable) break;
    cacheablePrefixTokens += p.tokens;
  }

  return { text, totalTokens, cacheablePrefixTokens, provenance, contractVersion: CONTEXT_CONTRACT_VERSION };
}
