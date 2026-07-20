/**
 * Automatic rollback thresholds (G20 / SPEC-197).
 *
 * A canary that measurably harms success, latency or cost is rolled back
 * AUTOMATICALLY — no human in the loop for the safety stop (INV-08). This module
 * deterministically compares canary metrics to the baseline and decides:
 *   CONTINUE — canary is as good or better → keep rolling out
 *   HALT     — inconclusive / marginal / too little data → pause, don't advance
 *   ROLLBACK — canary is worse beyond a threshold → revert now
 * Fail-closed: not enough data ⇒ HALT (never blindly CONTINUE). Integer nano-USD.
 */
export interface ReleaseMetrics {
  samples: number;
  successRate: number;      // 0..1
  p95LatencyMs: number;
  costPerSuccessNanoUsd: number;
}

export interface RollbackThresholds {
  minSamples: number;
  maxSuccessRateDrop: number;      // absolute, e.g. 0.02
  maxLatencyIncreaseMs: number;
  maxCostIncreaseNanoUsd: number;
}

export type RollbackDecision = 'CONTINUE' | 'HALT' | 'ROLLBACK';

export function decideRollback(baseline: ReleaseMetrics, canary: ReleaseMetrics, t: RollbackThresholds): { decision: RollbackDecision; reasons: string[] } {
  const reasons: string[] = [];
  // Fail-closed: too little canary data to judge → HALT.
  if (canary.samples < t.minSamples) return { decision: 'HALT', reasons: ['insufficient_samples'] };

  const successDrop = baseline.successRate - canary.successRate;
  const latencyIncrease = canary.p95LatencyMs - baseline.p95LatencyMs;
  const costIncrease = canary.costPerSuccessNanoUsd - baseline.costPerSuccessNanoUsd;

  if (successDrop > t.maxSuccessRateDrop) reasons.push('success_rate_drop');
  if (latencyIncrease > t.maxLatencyIncreaseMs) reasons.push('latency_increase');
  if (costIncrease > t.maxCostIncreaseNanoUsd) reasons.push('cost_increase');

  if (reasons.length > 0) return { decision: 'ROLLBACK', reasons };
  return { decision: 'CONTINUE', reasons: [] };
}
