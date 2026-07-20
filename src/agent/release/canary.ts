/**
 * Canary-release framework (G20 / SPEC-196).
 *
 * A change is rolled out to a small, growing fraction of traffic before going
 * full. Cohort membership is a DETERMINISTIC function of a stable key (so the same
 * request is always consistently canary-or-not at a given percentage) — a local
 * hash, not randomness (INV-01, replayable). Percentages are bounded 0..100.
 */
import { createHash } from 'node:crypto';

/** Deterministic 0..99 bucket for a stable key. */
export function cohortBucket(key: string): number {
  const h = createHash('sha256').update(key).digest();
  return h.readUInt16BE(0) % 100;
}

/** Is this key in the canary cohort at `percent` rollout? Monotonic in percent. */
export function inCanary(key: string, percent: number): boolean {
  const p = Math.max(0, Math.min(100, Math.floor(percent)));
  if (p <= 0) return false;
  if (p >= 100) return true;
  return cohortBucket(key) < p;
}

/** Canary cohort membership is monotonic: growing the % never removes a member. */
export function isMonotonicGrowth(key: string, fromPercent: number, toPercent: number): boolean {
  if (toPercent < fromPercent) return true; // shrinking is out of scope for this invariant
  return !inCanary(key, fromPercent) || inCanary(key, toPercent);
}
