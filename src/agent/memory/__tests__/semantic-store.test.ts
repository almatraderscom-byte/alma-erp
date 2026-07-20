import { describe, it, expect } from 'vitest';
import { InMemorySemanticStore, cosine, type MemoryRecord } from '../semantic-store';

const id = (t = 'alma') => ({ tenantId: t, actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });
const rec = (over: Partial<MemoryRecord> & { id: string; embedding: number[] }): MemoryRecord => ({
  identity: id(), text: 't', atMs: 1, tags: [], ...over,
});

describe('cosine', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('guards zero/mismatched vectors', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1], [1, 1])).toBe(0);
  });
});

describe('InMemorySemanticStore (SPEC-055)', () => {
  it('returns top-k by cosine similarity', () => {
    const s = new InMemorySemanticStore();
    s.add(rec({ id: 'near', embedding: [1, 0.1] }));
    s.add(rec({ id: 'far', embedding: [-1, 0] }));
    const hits = s.search('alma', [1, 0], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].record.id).toBe('near');
  });
  it('isolates by tenant at query time', () => {
    const s = new InMemorySemanticStore();
    s.add(rec({ id: 'mine', embedding: [1, 0] }));
    s.add(rec({ id: 'theirs', embedding: [1, 0], identity: id('rival') }));
    const hits = s.search('alma', [1, 0], 10);
    expect(hits.map((h) => h.record.id)).toEqual(['mine']);
  });
  it('rejects an invalid record (fail-closed)', () => {
    const s = new InMemorySemanticStore();
    expect(() => s.add(rec({ id: 'x', embedding: [] }))).toThrow();
  });
  it('is deterministic (stable ordering incl tie-break)', () => {
    const s = new InMemorySemanticStore();
    s.add(rec({ id: 'b', embedding: [1, 0] }));
    s.add(rec({ id: 'a', embedding: [1, 0] }));
    expect(s.search('alma', [1, 0], 2).map((h) => h.record.id)).toEqual(['a', 'b']);
  });
});
