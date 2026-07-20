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
import type { AdapterCall, AdapterResolver } from '@/agent/providers/runtime/adapter';
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
