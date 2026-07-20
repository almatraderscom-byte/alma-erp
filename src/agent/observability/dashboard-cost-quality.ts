/**
 * Cost and quality dashboard (G20 / SPEC-193).
 *
 * Aggregates the numbers the owner cares about into one deterministic dashboard
 * data model: total spend (nano-USD), spend by dimension (model/role/workflow),
 * success rate, and verified-claim rate. Pure computation over event rows — the
 * UI renders this model (INV-01). Money is integer nano-USD.
 */
export interface CostQualityRow {
  dimension: string;   // e.g. "model:gemini-3.1-pro" or "role:cs"
  nanoUsd: number;
  succeeded: boolean;
  claimVerified: boolean;
}

export interface CostQualityDashboard {
  totalNanoUsd: number;
  byDimension: Array<{ dimension: string; nanoUsd: number; share: number }>;
  successRate: number;
  verifiedClaimRate: number;
  rows: number;
}

export function buildCostQualityDashboard(rows: CostQualityRow[]): CostQualityDashboard {
  const valid = rows.filter((r) => Number.isInteger(r.nanoUsd) && r.nanoUsd >= 0);
  const totalNanoUsd = valid.reduce((s, r) => s + r.nanoUsd, 0);
  const dimMap = new Map<string, number>();
  for (const r of valid) dimMap.set(r.dimension, (dimMap.get(r.dimension) ?? 0) + r.nanoUsd);
  const byDimension = [...dimMap.entries()]
    .map(([dimension, nanoUsd]) => ({ dimension, nanoUsd, share: totalNanoUsd === 0 ? 0 : nanoUsd / totalNanoUsd }))
    .sort((a, b) => b.nanoUsd - a.nanoUsd);
  const n = valid.length || 1;
  return {
    totalNanoUsd,
    byDimension,
    successRate: valid.filter((r) => r.succeeded).length / n,
    verifiedClaimRate: valid.filter((r) => r.claimVerified).length / n,
    rows: valid.length,
  };
}
