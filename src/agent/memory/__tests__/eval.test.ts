import { describe, it, expect } from 'vitest';
import { evaluateRetrieval, type RetrievalCase } from '../eval';
import { InMemorySemanticStore, type MemoryRecord } from '../semantic-store';

const id = { tenantId: 'alma', actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' };
const rec = (idStr: string, embedding: number[]): MemoryRecord => ({ id: idStr, identity: id, text: idStr, embedding, atMs: 1, tags: [] });

function seededStore(): InMemorySemanticStore {
  const s = new InMemorySemanticStore();
  s.add(rec('orders', [1, 0, 0]));
  s.add(rec('payments', [0, 1, 0]));
  s.add(rec('marketing', [0, 0, 1]));
  return s;
}

describe('evaluateRetrieval (SPEC-060)', () => {
  it('scores perfect precision when the store retrieves the relevant memory', () => {
    const cases: RetrievalCase[] = [
      { name: 'orders-query', queryEmbedding: [1, 0.1, 0], relevantIds: ['orders'], k: 1 },
      { name: 'payments-query', queryEmbedding: [0, 1, 0.1], relevantIds: ['payments'], k: 1 },
    ];
    const report = evaluateRetrieval(seededStore(), 'alma', cases, 1000);
    expect(report.meanPrecisionAtK).toBe(1);
    expect(report.cases[0].hitIds).toEqual(['orders']);
  });

  it('detects poor retrieval (precision below 1)', () => {
    const cases: RetrievalCase[] = [
      { name: 'wrong-expectation', queryEmbedding: [1, 0, 0], relevantIds: ['marketing'], k: 1 },
    ];
    const report = evaluateRetrieval(seededStore(), 'alma', cases, 1000);
    expect(report.meanPrecisionAtK).toBe(0);
  });

  it('is deterministic + a quality gate (mean precision@1 == 1 on the fixtures)', () => {
    const cases: RetrievalCase[] = [
      { name: 'o', queryEmbedding: [1, 0, 0], relevantIds: ['orders'], k: 1 },
      { name: 'p', queryEmbedding: [0, 1, 0], relevantIds: ['payments'], k: 1 },
      { name: 'm', queryEmbedding: [0, 0, 1], relevantIds: ['marketing'], k: 1 },
    ];
    const report = evaluateRetrieval(seededStore(), 'alma', cases, 1000);
    expect(report.meanPrecisionAtK).toBeGreaterThanOrEqual(1); // gate
  });
});
