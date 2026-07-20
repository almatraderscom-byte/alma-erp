/**
 * Vendor-neutral model tiers (G16 / SPEC-151).
 *
 * The fabric routes by *tier* (a capability/cost class), never by a hard-coded
 * vendor model. Five tiers, cheapest → most capable:
 *
 *   T0  DETERMINISTIC     no LLM at all — pure code (INV-01)
 *   T1  CLASSIFIER        cheapest LLM: classify / extract, tiny JSON output
 *   T2  CHEAP_SPECIALIST  cheap role model: ops / orders / cs / marketing
 *   T3  STANDARD_REASONER standard reasoner: owner-facing head class
 *   T4  FRONTIER          frontier escalation: rare, approval + daily-cap gated
 *
 * Tier is an invariant boundary: the fabric NEVER silently promotes a request to
 * a stronger/costlier tier (INV: "never silently fall back to a stronger or more
 * expensive model"). Escalation is an explicit, caller-initiated new request.
 */
export const MODEL_TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface TierDefinition {
  tier: ModelTier;
  name: string;
  purpose: string;
  /** T0 is deterministic — no provider call is ever made */
  usesLlm: boolean;
  /** bound on the bounded prompt view (tokens) */
  maxInputTokens: number;
  /** hard ceiling on model output tokens for the tier */
  maxOutputTokens: number;
  /** in-tier retries permitted (failover across equivalents, never up a tier) */
  maxRetries: number;
  defaultTimeoutMs: number;
  /** T4 requires an explicit approval token + daily-cap check */
  requiresApproval: boolean;
  /** monotonic cost/capability rank; higher = costlier. Used to forbid auto-escalation. */
  rank: number;
}

export const TIER_DEFINITIONS: Record<ModelTier, TierDefinition> = {
  T0: {
    tier: 'T0',
    name: 'deterministic',
    purpose: 'Deterministic, code-only responses. No model call.',
    usesLlm: false,
    maxInputTokens: 8_000,
    maxOutputTokens: 0,
    maxRetries: 0,
    defaultTimeoutMs: 0,
    requiresApproval: false,
    rank: 0,
  },
  T1: {
    tier: 'T1',
    name: 'classifier-extractor',
    purpose: 'Cheapest LLM tier: classification and structured extraction. Tiny bounded JSON output.',
    usesLlm: true,
    maxInputTokens: 8_000,
    maxOutputTokens: 512,
    maxRetries: 1,
    defaultTimeoutMs: 15_000,
    requiresApproval: false,
    rank: 1,
  },
  T2: {
    tier: 'T2',
    name: 'cheap-specialist',
    purpose: 'Cheap role specialists: ops, orders, customer-service, marketing, research.',
    usesLlm: true,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxRetries: 1,
    defaultTimeoutMs: 30_000,
    requiresApproval: false,
    rank: 2,
  },
  T3: {
    tier: 'T3',
    name: 'standard-reasoner',
    purpose: 'Standard reasoner: owner-facing head class, reasoning allowed.',
    usesLlm: true,
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    maxRetries: 1,
    defaultTimeoutMs: 60_000,
    requiresApproval: false,
    rank: 3,
  },
  T4: {
    tier: 'T4',
    name: 'frontier-escalation',
    purpose: 'Frontier escalation: rare, high-risk / big-money. Approval + daily-cap gated.',
    usesLlm: true,
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    maxRetries: 0,
    defaultTimeoutMs: 120_000,
    requiresApproval: true,
    rank: 4,
  },
};

export function isModelTier(x: unknown): x is ModelTier {
  return typeof x === 'string' && (MODEL_TIERS as readonly string[]).includes(x);
}

export function tierDefinition(tier: ModelTier): TierDefinition {
  return TIER_DEFINITIONS[tier];
}

/** Rank of a tier (higher = costlier). */
export function tierRank(tier: ModelTier): number {
  return TIER_DEFINITIONS[tier].rank;
}
