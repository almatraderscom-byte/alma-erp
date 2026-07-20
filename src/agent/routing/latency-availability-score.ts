/**
 * Latency and availability score (G17 / SPEC-163).
 *
 * Collapses a model's measured availability (success rate) and latency into ONE
 * deterministic integer score in [0..1000], higher = better. Availability is used
 * as-is (per-mille success rate); latency is turned into a "speed" per-mille
 * relative to a reference latency, then combined by fixed integer weights.
 *
 * Fail-safe: an unknown latency (the SPEC-161 `MAX_SAFE_INTEGER` sentinel) or a
 * latency ≥ the reference yields speed 0; zero samples yield availability 0 too —
 * so an unmeasured model can never out-score a measured responsive one. Pure
 * integer arithmetic — no floats, no clock read, no provider call (INV-01).
 */
import { PER_MILLE, successRateMilli, avgLatencyMs, type PerfRecord } from './performance-records';

export interface LatencyAvailabilityWeights {
  availabilityWeightMilli: number;
  speedWeightMilli: number; // sum with availability must be 1000
}

export const DEFAULT_LATENCY_AVAILABILITY_WEIGHTS: LatencyAvailabilityWeights = {
  availabilityWeightMilli: 500,
  speedWeightMilli: 500,
};

function assertWeights(w: LatencyAvailabilityWeights): void {
  if (w.availabilityWeightMilli < 0 || w.speedWeightMilli < 0 || w.availabilityWeightMilli + w.speedWeightMilli !== PER_MILLE) {
    throw new Error('latency-availability weights must be non-negative and sum to 1000');
  }
}

/** speed in per-mille: 1000 at latency 0, 0 at latency ≥ reference (fail-safe). */
export function speedMilli(avgLatencyMs: number, refLatencyMs: number): number {
  if (refLatencyMs <= 0) return 0;
  if (avgLatencyMs < 0) return 0;
  if (avgLatencyMs >= refLatencyMs) return 0; // ≥ reference (incl. unknown sentinel) → 0
  return PER_MILLE - Math.floor((avgLatencyMs * PER_MILLE) / refLatencyMs);
}

export interface LatencyAvailabilityInput {
  availabilityMilli: number;
  avgLatencyMs: number;
  refLatencyMs: number;
}

/** Combined latency-availability score in [0..1000] (higher = better). */
export function latencyAvailabilityScore(
  input: LatencyAvailabilityInput,
  weights: LatencyAvailabilityWeights = DEFAULT_LATENCY_AVAILABILITY_WEIGHTS,
): number {
  assertWeights(weights);
  const avail = Math.max(0, Math.min(PER_MILLE, Math.floor(input.availabilityMilli)));
  const speed = speedMilli(input.avgLatencyMs, input.refLatencyMs);
  return Math.floor((avail * weights.availabilityWeightMilli + speed * weights.speedWeightMilli) / PER_MILLE);
}

/** Score a SPEC-161 record against a reference latency. Zero-sample → 0 (fail-safe). */
export function scoreRecordLatencyAvailability(
  record: PerfRecord,
  refLatencyMs: number,
  weights: LatencyAvailabilityWeights = DEFAULT_LATENCY_AVAILABILITY_WEIGHTS,
): number {
  if (record.samples === 0) return 0;
  return latencyAvailabilityScore(
    { availabilityMilli: successRateMilli(record), avgLatencyMs: avgLatencyMs(record), refLatencyMs },
    weights,
  );
}
