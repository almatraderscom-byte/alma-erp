/**
 * Provider timeout and quota controls (G16 / SPEC-158).
 *
 * Deterministic runtime primitives — no wall clock, no network. Time is supplied
 * by an injected `now()` function so tests are reproducible:
 *
 *  - `invokeWithTimeout` brackets an adapter call and reclassifies it as TIMEOUT
 *    when the measured elapsed time exceeds the call's `timeoutMs`. (A hard
 *    in-flight abort via AbortController is a documented production seam; the
 *    deterministic model here is a post-hoc elapsed check.)
 *  - `createQuotaController` is a fixed-window per-provider rate limiter: it
 *    admits up to `limitPerWindow` calls per `windowMs` and otherwise denies with
 *    a precise `retryAfterMs` (INV-06: a denied call is a definite outcome, not a
 *    blind retry).
 */
import type { AdapterCall, AdapterOutcome, ProviderAdapter } from './adapter';

export type NowFn = () => number;

/** Bracket an adapter call; classify as TIMEOUT if elapsed exceeds the budget. */
export async function invokeWithTimeout(adapter: ProviderAdapter, call: AdapterCall, now: NowFn): Promise<AdapterOutcome> {
  const start = now();
  const outcome = await adapter.invoke(call);
  const elapsed = now() - start;
  if (call.timeoutMs > 0 && elapsed > call.timeoutMs) {
    return { kind: 'TIMEOUT' };
  }
  return outcome;
}

export interface QuotaControllerOptions {
  limitPerWindow: number;
  windowMs: number;
}

export type QuotaDecision = { ok: true } | { ok: false; retryAfterMs: number };

export interface QuotaController {
  /** try to admit one call for `provider` at time `nowMs` */
  tryAcquire(provider: string, nowMs: number): QuotaDecision;
}

/** Fixed-window per-provider quota. Deterministic; time is passed in. */
export function createQuotaController(opts: QuotaControllerOptions): QuotaController {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    tryAcquire(provider: string, nowMs: number): QuotaDecision {
      const w = windows.get(provider);
      if (!w || nowMs - w.start >= opts.windowMs) {
        windows.set(provider, { start: nowMs, count: 1 });
        return { ok: true };
      }
      if (w.count < opts.limitPerWindow) {
        w.count += 1;
        return { ok: true };
      }
      return { ok: false, retryAfterMs: Math.max(0, w.start + opts.windowMs - nowMs) };
    },
  };
}
