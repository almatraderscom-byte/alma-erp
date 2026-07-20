/**
 * Semantic read-only response cache (G07 / SPEC-066).
 *
 * Serves a cached answer when a NEW read-only query is semantically close to a
 * previously-answered one (cosine ≥ threshold, reusing G06's similarity). Only
 * for read-only/deterministic intents — never for actions (SPEC-068). Strictly
 * tenant-isolated. Embeddings are inputs (no model call here). Deterministic.
 */
import { cosine } from '../memory/semantic-store';

export interface SemanticCacheEntry {
  tenantId: string;
  queryEmbedding: number[];
  response: string;
  savedNanoUsd: number;
}

export interface SemanticHit {
  response: string;
  score: number;
  savedNanoUsd: number;
}

export class SemanticResponseCache {
  private readonly entries: SemanticCacheEntry[] = [];

  put(entry: SemanticCacheEntry): void {
    if (!entry.tenantId || entry.queryEmbedding.length === 0) throw new Error('invalid semantic cache entry');
    this.entries.push({ ...entry, queryEmbedding: [...entry.queryEmbedding] });
  }

  /** Best same-tenant entry with cosine ≥ threshold, or null (a miss). */
  lookup(tenantId: string, queryEmbedding: number[], threshold: number): SemanticHit | null {
    let best: SemanticHit | null = null;
    for (const e of this.entries) {
      if (e.tenantId !== tenantId) continue; // isolation: never cross tenants
      const score = cosine(queryEmbedding, e.queryEmbedding);
      if (score >= threshold && (best === null || score > best.score)) {
        best = { response: e.response, score, savedNanoUsd: e.savedNanoUsd };
      }
    }
    return best;
  }
}
