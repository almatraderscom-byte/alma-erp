/**
 * Memory retrieval evaluation suite (G06 / SPEC-060).
 *
 * Measures retrieval quality (precision@k) of the semantic store + relevance
 * ranking against fixtures with known-relevant ids, so regressions in recall are
 * caught. Deterministic — embeddings and expected results are supplied. No LLM.
 */
import type { SemanticMemoryStore } from './semantic-store';
import { rankByRelevance } from './relevance';

export interface RetrievalCase {
  name: string;
  queryEmbedding: number[];
  relevantIds: string[];
  k: number;
}

export interface CaseResult {
  name: string;
  precisionAtK: number;
  hitIds: string[];
}

export interface EvaluationReport {
  cases: CaseResult[];
  meanPrecisionAtK: number;
}

export function evaluateRetrieval(
  store: SemanticMemoryStore,
  tenantId: string,
  cases: RetrievalCase[],
  nowMs: number,
): EvaluationReport {
  const results: CaseResult[] = cases.map((c) => {
    const ranked = rankByRelevance(store.search(tenantId, c.queryEmbedding, c.k), { nowMs });
    const hitIds = ranked.slice(0, c.k).map((h) => h.record.id);
    const relevant = new Set(c.relevantIds);
    const truePositives = hitIds.filter((id) => relevant.has(id)).length;
    const precisionAtK = hitIds.length === 0 ? 0 : truePositives / hitIds.length;
    return { name: c.name, precisionAtK, hitIds };
  });
  const mean = results.length === 0 ? 0 : results.reduce((s, r) => s + r.precisionAtK, 0) / results.length;
  return { cases: results, meanPrecisionAtK: mean };
}
