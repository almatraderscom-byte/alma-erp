import { describe, it, expect } from 'vitest';
import { MODEL_TIERS, TIER_DEFINITIONS, isModelTier, tierDefinition, tierRank } from '../tiers';

describe('SPEC-151 model tiers', () => {
  it('defines exactly T0..T4 in ascending cost rank', () => {
    expect([...MODEL_TIERS]).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
    const ranks = MODEL_TIERS.map((t) => tierRank(t));
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
    // strictly increasing — a stronger tier is always costlier
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it('T0 is the only non-LLM tier and has zero output budget', () => {
    expect(TIER_DEFINITIONS.T0.usesLlm).toBe(false);
    expect(TIER_DEFINITIONS.T0.maxOutputTokens).toBe(0);
    for (const t of ['T1', 'T2', 'T3', 'T4'] as const) expect(TIER_DEFINITIONS[t].usesLlm).toBe(true);
  });

  it('only T4 requires approval', () => {
    expect(TIER_DEFINITIONS.T4.requiresApproval).toBe(true);
    for (const t of ['T0', 'T1', 'T2', 'T3'] as const) expect(TIER_DEFINITIONS[t].requiresApproval).toBe(false);
  });

  it('output ceilings are non-decreasing by tier', () => {
    const caps = MODEL_TIERS.map((t) => TIER_DEFINITIONS[t].maxOutputTokens);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
  });

  it('type guard + accessor', () => {
    expect(isModelTier('T3')).toBe(true);
    expect(isModelTier('T9')).toBe(false);
    expect(isModelTier(3)).toBe(false);
    expect(tierDefinition('T3').name).toBe('standard-reasoner');
  });
});
