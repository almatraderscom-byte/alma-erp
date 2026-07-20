import { describe, it, expect } from 'vitest';
import { modelCallBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize } from '../../control-plane/cost/governor';

describe('modelCallBudget (SPEC-036)', () => {
  it('rejects a single call whose worst-case exceeds the per-call ceiling', () => {
    const s = new InMemoryBudgetStore();
    const b = modelCallBudget('c1', 's1', 100);
    expect(authorize(101, [b], s).status).toBe('BUDGET_EXCEEDED');
    expect(authorize(100, [b], s).status).toBe('ALLOWED');
  });
  it('is keyed per call/step', () => {
    expect(modelCallBudget('c1', 's1', 1).key).not.toBe(modelCallBudget('c1', 's2', 1).key);
  });
});
