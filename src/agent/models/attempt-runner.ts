/**
 * Guarded attempt runner (G16 / SPEC-158).
 *
 * The fabric's `AttemptRunner` seam, implemented with the provider-runtime
 * timeout + quota primitives. It runs the PRIMARY candidate only (single attempt;
 * SPEC-159 adds in-tier failover across the remaining candidates) subject to:
 *   - a per-provider quota check (deny → `MODEL_PROVIDER_QUOTA_EXCEEDED`, provider
 *     not called);
 *   - a deterministic timeout classification (elapsed > budget → TIMEOUT).
 *
 * The quota controller is passed in by the caller so its window state persists
 * across fabric calls (a fresh controller per call would never rate-limit).
 */
import { invokeWithTimeout, type QuotaController } from '@/agent/providers/runtime/timeout-quota';
import { shouldFailover } from '@/agent/providers/runtime/failover';
import type { AdapterCall, AdapterOutcome, AdapterResolver } from '@/agent/providers/runtime/adapter';
import { MODEL_REASON_CODES } from './reason-codes';
import type { AttemptRunner } from './fabric';
import type { Clock } from './ports';

export interface GuardedAttemptRunnerDeps {
  clock: Clock;
  quota?: QuotaController;
}

export function createGuardedAttemptRunner(deps: GuardedAttemptRunnerDeps): AttemptRunner {
  const now = () => deps.clock.now();
  return {
    async run(candidates, makeCall: (b: { provider: string; model: string }) => AdapterCall, resolver: AdapterResolver) {
      const primary = candidates[0];
      if (!primary) return { outcome: null, attempts: 0, reasonCodes: [MODEL_REASON_CODES.ADAPTER_MISSING] };
      const adapter = resolver.resolve(primary.provider);
      if (!adapter || !adapter.supports(primary.model)) {
        return { outcome: null, attempts: 0, reasonCodes: [MODEL_REASON_CODES.ADAPTER_MISSING] };
      }
      if (deps.quota) {
        const q = deps.quota.tryAcquire(primary.provider, now());
        if (!q.ok) {
          // definite outcome, not a blind retry — carry the precise backoff
          return { outcome: null, attempts: 1, reasonCodes: [MODEL_REASON_CODES.PROVIDER_QUOTA_EXCEEDED, `retryAfterMs:${q.retryAfterMs}`] };
        }
      }
      const outcome = await invokeWithTimeout(adapter, makeCall(primary), now);
      return { outcome, provider: primary.provider, model: primary.model, attempts: 1 };
    },
  };
}

/**
 * Failover attempt runner (G16 / SPEC-159).
 *
 * Iterates the tier's candidate list in order. A transient failure (TIMEOUT /
 * RETRYABLE), a quota denial, or a missing adapter moves to the NEXT candidate; a
 * permanent FINAL error or an UNKNOWN outcome stops immediately (never retried).
 * Failover stays strictly within the tier — the candidate list is the same tier's
 * equivalents, so it never escalates to a stronger/costlier tier.
 */
function mapTransient(outcome: AdapterOutcome): string {
  return outcome.kind === 'TIMEOUT' ? MODEL_REASON_CODES.PROVIDER_TIMEOUT : MODEL_REASON_CODES.PROVIDER_RETRYABLE;
}

export function createFailoverAttemptRunner(deps: GuardedAttemptRunnerDeps): AttemptRunner {
  const now = () => deps.clock.now();
  return {
    async run(candidates, makeCall: (b: { provider: string; model: string }) => AdapterCall, resolver: AdapterResolver) {
      const reasons: string[] = [];
      let attempts = 0;
      for (const cand of candidates) {
        const adapter = resolver.resolve(cand.provider);
        if (!adapter || !adapter.supports(cand.model)) {
          reasons.push(MODEL_REASON_CODES.ADAPTER_MISSING);
          continue; // provider not configured → try next equivalent
        }
        if (deps.quota) {
          const q = deps.quota.tryAcquire(cand.provider, now());
          if (!q.ok) {
            reasons.push(MODEL_REASON_CODES.PROVIDER_QUOTA_EXCEEDED);
            continue; // rate-limited → try next equivalent (provider not called)
          }
        }
        attempts += 1;
        const outcome = await invokeWithTimeout(adapter, makeCall(cand), now);
        if (outcome.kind === 'OK') {
          return { outcome, provider: cand.provider, model: cand.model, attempts };
        }
        if (!shouldFailover(outcome)) {
          // FINAL (permanent) or UNKNOWN (reconciliation) — do not try other providers
          return { outcome, provider: cand.provider, model: cand.model, attempts };
        }
        reasons.push(mapTransient(outcome)); // transient → record and try next
      }
      return { outcome: null, attempts, reasonCodes: [...reasons, MODEL_REASON_CODES.ALL_PROVIDERS_FAILED] };
    },
  };
}
