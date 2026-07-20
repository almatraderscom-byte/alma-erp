/**
 * Provider failover rules (G16 / SPEC-159).
 *
 * The deterministic policy that decides whether a failed provider attempt may be
 * retried on the NEXT candidate. The governing invariant: failover only ever
 * moves ACROSS equivalents inside the same tier's candidate list — it NEVER
 * escalates to a stronger/costlier tier.
 *
 * Trigger rules:
 *   - TIMEOUT / RETRYABLE  → transient → try the next candidate.
 *   - FINAL                → permanent request error → stop (retrying another
 *                            provider just burns money on the same bad request).
 *   - UNKNOWN              → reconciliation, never retried (INV-06) → stop.
 *   - OK                   → done.
 * Quota denial and adapter-missing are handled by the runner as "skip to next
 * candidate" (the provider was never actually called).
 */
import type { AdapterOutcome } from './adapter';

/** Outcome kinds that make failover to the next candidate legal. */
export const FAILOVER_TRIGGER_KINDS = ['TIMEOUT', 'RETRYABLE'] as const;

/** True when a failed attempt may be retried on the next in-tier candidate. */
export function shouldFailover(outcome: AdapterOutcome): boolean {
  return outcome.kind === 'TIMEOUT' || outcome.kind === 'RETRYABLE';
}
