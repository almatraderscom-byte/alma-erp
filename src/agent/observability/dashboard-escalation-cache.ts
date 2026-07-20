/**
 * Escalation and cache dashboard (G20 / SPEC-194).
 *
 * Two operational health signals in one deterministic model: how often the agent
 * ESCALATES (to approval, to a frontier model, to a human) — a cost + autonomy
 * signal — and how well the CACHE performs (hit rate, nano-USD saved). Pure over
 * event rows (INV-01, integer nano-USD).
 */
export interface EscalationRow { kind: 'approval' | 'frontier' | 'human' | 'opus'; count: number }
export interface CacheRow { lookups: number; hits: number; savedNanoUsd: number }

export interface EscalationCacheDashboard {
  escalationsByKind: Record<string, number>;
  totalEscalations: number;
  cacheHitRate: number;
  cacheSavedNanoUsd: number;
}

export function buildEscalationCacheDashboard(escalations: EscalationRow[], cache: CacheRow[]): EscalationCacheDashboard {
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const e of escalations) {
    if (!Number.isInteger(e.count) || e.count < 0) continue;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + e.count;
    total += e.count;
  }
  let lookups = 0, hits = 0, saved = 0;
  for (const c of cache) {
    if (!Number.isInteger(c.lookups) || c.lookups < 0) continue;
    lookups += c.lookups;
    hits += Math.min(c.hits, c.lookups);
    if (Number.isInteger(c.savedNanoUsd) && c.savedNanoUsd >= 0) saved += c.savedNanoUsd;
  }
  return {
    escalationsByKind: byKind,
    totalEscalations: total,
    cacheHitRate: lookups === 0 ? 0 : hits / lookups,
    cacheSavedNanoUsd: saved,
  };
}
