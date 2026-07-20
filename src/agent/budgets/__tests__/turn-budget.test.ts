import { describe, it, expect } from 'vitest';
import { turnBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize } from '../../control-plane/cost/governor';

describe('turnBudget (SPEC-035)', () => {
  it('caps a single turn and is keyed by correlation', () => {
    const s = new InMemoryBudgetStore();
    const b = turnBudget('corr-1', 50);
    expect(authorize(50, [b], s).status).toBe('ALLOWED');
    expect(authorize(1, [b], s).status).toBe('BUDGET_EXCEEDED');
    expect(turnBudget('corr-1', 1).key).not.toBe(turnBudget('corr-2', 1).key);
  });
});
