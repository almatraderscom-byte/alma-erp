/**
 * Cache savings and correctness dashboard (G07 / SPEC-070).
 *
 * Aggregates cache activity into money saved (nano-USD, from G03 estimates on
 * each hit) and a hit rate, plus a correctness signal (cached responses that were
 * later re-validated). Deterministic; consumes recorded events. This is how the
 * owner sees the cache is actually saving money without breaking correctness.
 */
export interface CacheEvent {
  kind: 'prefix' | 'exact' | 'semantic' | 'tool';
  hit: boolean;
  savedNanoUsd: number; // cost avoided on a hit (0 on a miss)
  correctnessVerified: boolean; // was a served hit later confirmed correct?
}

export interface CacheSavingsReport {
  total: number;
  hits: number;
  misses: number;
  hitRate: number; // 0..1
  savedNanoUsd: number;
  byKind: Record<string, { hits: number; savedNanoUsd: number }>;
  verifiedHitRate: number; // verified hits / hits (0..1)
}

export function computeSavings(events: CacheEvent[]): CacheSavingsReport {
  const byKind: Record<string, { hits: number; savedNanoUsd: number }> = {};
  let hits = 0, saved = 0, verified = 0;
  for (const e of events) {
    if (e.hit) {
      hits++;
      saved += Math.max(0, e.savedNanoUsd);
      if (e.correctnessVerified) verified++;
      const k = (byKind[e.kind] ??= { hits: 0, savedNanoUsd: 0 });
      k.hits++; k.savedNanoUsd += Math.max(0, e.savedNanoUsd);
    }
  }
  const total = events.length;
  return {
    total,
    hits,
    misses: total - hits,
    hitRate: total === 0 ? 0 : hits / total,
    savedNanoUsd: saved,
    byKind,
    verifiedHitRate: hits === 0 ? 1 : verified / hits,
  };
}
