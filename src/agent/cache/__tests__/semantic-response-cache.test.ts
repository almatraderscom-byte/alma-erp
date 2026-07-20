import { describe, it, expect } from 'vitest';
import { SemanticResponseCache } from '../semantic-response-cache';

describe('semantic response cache (SPEC-066)', () => {
  it('hits a semantically-similar query above threshold', () => {
    const c = new SemanticResponseCache();
    c.put({ tenantId: 'alma', queryEmbedding: [1, 0, 0], response: 'orders answer', savedNanoUsd: 5 });
    const hit = c.lookup('alma', [0.99, 0.1, 0], 0.9);
    expect(hit?.response).toBe('orders answer');
    expect(hit!.score).toBeGreaterThanOrEqual(0.9);
  });
  it('misses when no entry is similar enough', () => {
    const c = new SemanticResponseCache();
    c.put({ tenantId: 'alma', queryEmbedding: [1, 0, 0], response: 'x', savedNanoUsd: 1 });
    expect(c.lookup('alma', [0, 1, 0], 0.9)).toBeNull();
  });
  it('NEVER serves another tenant a cached answer (isolation)', () => {
    const c = new SemanticResponseCache();
    c.put({ tenantId: 'alma', queryEmbedding: [1, 0, 0], response: 'secret', savedNanoUsd: 1 });
    expect(c.lookup('rival', [1, 0, 0], 0.5)).toBeNull();
  });
  it('picks the closest of several candidates', () => {
    const c = new SemanticResponseCache();
    c.put({ tenantId: 'alma', queryEmbedding: [1, 0], response: 'near', savedNanoUsd: 1 });
    c.put({ tenantId: 'alma', queryEmbedding: [0.6, 0.8], response: 'far', savedNanoUsd: 1 });
    expect(c.lookup('alma', [1, 0.05], 0.5)!.response).toBe('near');
  });
  it('rejects an invalid entry', () => {
    expect(() => new SemanticResponseCache().put({ tenantId: '', queryEmbedding: [1], response: 'x', savedNanoUsd: 0 })).toThrow();
  });
});
