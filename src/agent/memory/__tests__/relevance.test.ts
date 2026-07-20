import { describe, it, expect } from 'vitest';
import { rankByRelevance, recencyFactor, scoreRelevance } from '../relevance';
import type { SearchHit } from '../semantic-store';

const id = { tenantId: 'alma', actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' };
const hit = (idStr: string, score: number, atMs: number): SearchHit => ({
  record: { id: idStr, identity: id, text: 't', embedding: [1], atMs, tags: [] }, score,
});
const NOW = 1_000_000_000;
const DAY = 86_400_000;

describe('recencyFactor (SPEC-057)', () => {
  it('is 1 at now and 0.5 at one half-life', () => {
    expect(recencyFactor(NOW, NOW, 30 * DAY)).toBeCloseTo(1);
    expect(recencyFactor(NOW - 30 * DAY, NOW, 30 * DAY)).toBeCloseTo(0.5);
  });
});

describe('scoreRelevance', () => {
  it('blends similarity and recency', () => {
    const s = scoreRelevance(hit('a', 1, NOW), { nowMs: NOW });
    expect(s.relevance).toBeGreaterThan(0.9); // high sim + recent
  });
});

describe('rankByRelevance', () => {
  it('prefers a recent on-topic memory over an old equally-similar one', () => {
    const ranked = rankByRelevance([hit('old', 1, NOW - 90 * DAY), hit('new', 1, NOW)], { nowMs: NOW });
    expect(ranked[0].record.id).toBe('new');
  });
  it('prefers a more-similar memory when recency is equal', () => {
    const ranked = rankByRelevance([hit('lo', 0.2, NOW), hit('hi', 0.95, NOW)], { nowMs: NOW });
    expect(ranked[0].record.id).toBe('hi');
  });
  it('is deterministic (tie-break by id)', () => {
    const ranked = rankByRelevance([hit('b', 1, NOW), hit('a', 1, NOW)], { nowMs: NOW });
    expect(ranked.map((h) => h.record.id)).toEqual(['a', 'b']);
  });
});
