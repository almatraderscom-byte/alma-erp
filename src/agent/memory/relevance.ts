/**
 * Memory relevance scoring (G06 / SPEC-057).
 *
 * Combines semantic similarity (cosine, SPEC-055) with recency decay into one
 * deterministic relevance score, so retrieval favours memories that are both
 * on-topic AND recent. Pure; `nowMs` and half-life supplied by the caller.
 */
import type { SearchHit } from './semantic-store';

export interface RelevanceOpts {
  nowMs: number;
  /** recency half-life in ms (older memories decay); default 30 days */
  halfLifeMs?: number;
  /** weight of similarity vs recency (0..1); default 0.7 similarity */
  similarityWeight?: number;
}

const DAY = 86_400_000;

/** Recency factor in (0,1]: 1 at now, 0.5 at one half-life old. */
export function recencyFactor(atMs: number, nowMs: number, halfLifeMs: number): number {
  const age = Math.max(0, nowMs - atMs);
  return Math.pow(0.5, age / halfLifeMs);
}

export interface ScoredHit extends SearchHit {
  relevance: number;
  recency: number;
}

export function scoreRelevance(hit: SearchHit, opts: RelevanceOpts): ScoredHit {
  const halfLife = opts.halfLifeMs ?? 30 * DAY;
  const w = opts.similarityWeight ?? 0.7;
  const recency = recencyFactor(hit.record.atMs, opts.nowMs, halfLife);
  // normalise cosine (-1..1) to (0..1) for blending
  const sim = (hit.score + 1) / 2;
  const relevance = w * sim + (1 - w) * recency;
  return { ...hit, relevance, recency };
}

/** Rank hits by combined relevance, descending (deterministic tie-break by id). */
export function rankByRelevance(hits: SearchHit[], opts: RelevanceOpts): ScoredHit[] {
  return hits
    .map((h) => scoreRelevance(h, opts))
    .sort((a, b) => b.relevance - a.relevance || a.record.id.localeCompare(b.record.id));
}
