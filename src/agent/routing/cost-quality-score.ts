/**
 * Cost-quality model score (G17 / SPEC-162).
 *
 * Collapses a model's measured quality and its (G03) cost into ONE deterministic
 * integer score in [0..1000], higher = better. Quality is used as-is (per-mille);
 * cost is turned into a "cheapness" per-mille relative to a reference cost, then
 * the two are combined by fixed integer weights.
 *
 * Fail-safe: an unknown cost (the SPEC-161 `MAX_SAFE_INTEGER` sentinel) or a cost
 * ≥ the reference yields cheapness 0, so a model with no measured cost can never
 * out-score a measured cheaper one. Pure integer arithmetic — no floats, no time,
 * no provider call (INV-01).
 */
import { PER_MILLE, avgQualityMilli, avgCostNanoUsd, type PerfRecord } from './performance-records';

export interface CostQualityWeights {
  qualityWeightMilli: number; // weight on quality, per-mille
  cheapnessWeightMilli: number; // weight on cheapness, per-mille (sum must be 1000)
}

export const DEFAULT_COST_QUALITY_WEIGHTS: CostQualityWeights = {
  qualityWeightMilli: 600,
  cheapnessWeightMilli: 400,
};

function assertWeights(w: CostQualityWeights): void {
  if (w.qualityWeightMilli < 0 || w.cheapnessWeightMilli < 0 || w.qualityWeightMilli + w.cheapnessWeightMilli !== PER_MILLE) {
    throw new Error('cost-quality weights must be non-negative and sum to 1000');
  }
}

/** cheapness in per-mille: 1000 at cost 0, 0 at cost ≥ reference (fail-safe). */
export function cheapnessMilli(avgCostNanoUsd: number, refCostNanoUsd: number): number {
  if (refCostNanoUsd <= 0) return 0; // cannot normalize → fail-safe to 0
  if (avgCostNanoUsd < 0) return 0;
  if (avgCostNanoUsd >= refCostNanoUsd) return 0; // ≥ reference (incl. unknown sentinel) → 0
  return PER_MILLE - Math.floor((avgCostNanoUsd * PER_MILLE) / refCostNanoUsd);
}

export interface CostQualityInput {
  qualityMilli: number;
  avgCostNanoUsd: number;
  refCostNanoUsd: number;
}

/** Combined cost-quality score in [0..1000] (higher = better). */
export function costQualityScore(input: CostQualityInput, weights: CostQualityWeights = DEFAULT_COST_QUALITY_WEIGHTS): number {
  assertWeights(weights);
  const q = Math.max(0, Math.min(PER_MILLE, Math.floor(input.qualityMilli)));
  const cheap = cheapnessMilli(input.avgCostNanoUsd, input.refCostNanoUsd);
  return Math.floor((q * weights.qualityWeightMilli + cheap * weights.cheapnessWeightMilli) / PER_MILLE);
}

/** Score a SPEC-161 record against a reference cost. Zero-sample → 0 (fail-safe). */
export function scoreRecordCostQuality(
  record: PerfRecord,
  refCostNanoUsd: number,
  weights: CostQualityWeights = DEFAULT_COST_QUALITY_WEIGHTS,
): number {
  if (record.samples === 0) return 0;
  return costQualityScore(
    { qualityMilli: avgQualityMilli(record), avgCostNanoUsd: avgCostNanoUsd(record), refCostNanoUsd },
    weights,
  );
}
