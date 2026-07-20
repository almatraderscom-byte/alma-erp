/**
 * Model bake-off automation (G20 / SPEC-198).
 *
 * Runs candidate models over the golden dataset (G19 evals) and picks a winner by
 * a deterministic composite score — reward accuracy, penalise cost and latency —
 * with a hard minimum-accuracy floor (a cheap model that fails tasks is
 * disqualified, not chosen). No LLM judges the bake-off (INV-01). Integer nano-USD.
 */
export interface ModelResult {
  model: string;
  accuracy: number;              // 0..1 on golden tasks
  costPerSuccessNanoUsd: number;
  p95LatencyMs: number;
}

export interface BakeOffWeights {
  minAccuracy: number;
  costWeight: number;    // per nano-USD
  latencyWeight: number; // per ms
}

export interface RankedModel extends ModelResult { score: number; disqualified: boolean }

/** Higher score = better. Accuracy dominates; cost + latency subtract. */
function scoreOf(r: ModelResult, w: BakeOffWeights): number {
  return r.accuracy - r.costPerSuccessNanoUsd * w.costWeight - r.p95LatencyMs * w.latencyWeight;
}

export function rankModels(results: ModelResult[], w: BakeOffWeights): RankedModel[] {
  return results
    .map((r) => ({ ...r, score: scoreOf(r, w), disqualified: r.accuracy < w.minAccuracy }))
    .sort((a, b) => {
      if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1; // qualified first
      return b.score - a.score;
    });
}

/** The winning model, or null if every candidate is disqualified (fail-closed). */
export function pickWinner(results: ModelResult[], w: BakeOffWeights): RankedModel | null {
  const ranked = rankModels(results, w);
  const top = ranked[0];
  return top && !top.disqualified ? top : null;
}
