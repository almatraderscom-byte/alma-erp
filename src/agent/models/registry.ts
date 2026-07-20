/**
 * Vendor-neutral tier → model registry (G16 / SPEC-151).
 *
 * Maps each LLM tier to an ORDERED list of candidate `{provider, model}` bindings
 * (primary first, failover equivalents after — SPEC-159 consumes the order). The
 * fabric resolves a tier to a concrete model *only here*; callers never name a
 * vendor model. Bindings reference models priced in the G03 pricing registry so
 * cost accounting stays correlated.
 *
 * Owner allocation (CLAUDE.md, 2026-07): DeepSeek for cheap tiers, Qwen for
 * customer-service, Gemini 3.1 Pro as the standard head, Opus 4.8 for rare
 * frontier escalation. All values are tunable seams (a later phase may swap them
 * without touching the fabric).
 */
import type { ModelTier } from './tiers';

export interface ModelBinding {
  provider: string;
  model: string;
  /** optional role hint for T2 specialist selection (ops / orders / cs / …) */
  role?: string;
}

export type TierModelTable = Record<ModelTier, ModelBinding[]>;

/**
 * Default allocation. T0 has no model (deterministic). Every LLM tier lists at
 * least one binding; multiple entries form an in-tier failover chain.
 */
export const DEFAULT_TIER_MODELS: TierModelTable = {
  T0: [],
  T1: [
    { provider: 'openrouter', model: 'or-deepseek-v4-flash' },
    { provider: 'google', model: 'gemini-3.1-pro' },
  ],
  T2: [
    { provider: 'openrouter', model: 'or-deepseek-v4-flash', role: 'ops' },
    { provider: 'openrouter', model: 'or-qwen3-max', role: 'cs' },
  ],
  T3: [
    { provider: 'google', model: 'gemini-3.1-pro' },
    { provider: 'openrouter', model: 'or-qwen3-max' },
  ],
  T4: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
};

export interface TierModelRegistry {
  /** ordered candidates for a tier (primary first); [] for T0 */
  candidates(tier: ModelTier): ModelBinding[];
  /** the primary (first) binding for a tier, honouring an optional role hint */
  primary(tier: ModelTier, role?: string): ModelBinding | null;
}

export function createTierModelRegistry(table: TierModelTable = DEFAULT_TIER_MODELS): TierModelRegistry {
  return {
    candidates(tier: ModelTier): ModelBinding[] {
      return table[tier] ?? [];
    },
    primary(tier: ModelTier, role?: string): ModelBinding | null {
      const list = table[tier] ?? [];
      if (list.length === 0) return null;
      if (role) {
        const roleMatch = list.find((b) => b.role === role);
        if (roleMatch) return roleMatch;
      }
      return list[0];
    },
  };
}
