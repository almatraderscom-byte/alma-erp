import { describe, it, expect } from 'vitest';
import { rankModels, pickWinner, type ModelResult, type BakeOffWeights } from '../bake-off';

const w: BakeOffWeights = { minAccuracy: 0.9, costWeight: 1e-9, latencyWeight: 1e-7 };
const models: ModelResult[] = [
  { model: 'gemini', accuracy: 0.97, costPerSuccessNanoUsd: 200_000_000, p95LatencyMs: 8000 },
  { model: 'deepseek', accuracy: 0.95, costPerSuccessNanoUsd: 50_000_000, p95LatencyMs: 6000 },
  { model: 'cheapo', accuracy: 0.60, costPerSuccessNanoUsd: 1_000_000, p95LatencyMs: 3000 },
];

describe('model bake-off (SPEC-198)', () => {
  it('ranks qualified models by composite score, disqualified last', () => {
    const r = rankModels(models, w);
    expect(r[r.length - 1].model).toBe('cheapo'); // disqualified (low accuracy)
    expect(r[r.length - 1].disqualified).toBe(true);
  });
  it('picks a winner among qualified candidates', () => {
    const winner = pickWinner(models, w);
    expect(winner).not.toBeNull();
    expect(['gemini', 'deepseek']).toContain(winner!.model);
  });
  it('a cheap-but-inaccurate model is never the winner', () => {
    expect(pickWinner(models, w)!.model).not.toBe('cheapo');
  });
  it('returns null if every candidate is disqualified (fail-closed)', () => {
    expect(pickWinner([{ model: 'x', accuracy: 0.1, costPerSuccessNanoUsd: 1, p95LatencyMs: 1 }], w)).toBeNull();
  });
});
