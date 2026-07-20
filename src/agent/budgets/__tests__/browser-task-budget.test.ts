import { describe, it, expect } from 'vitest';
import { browserTaskBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize } from '../../control-plane/cost/governor';

describe('browserTaskBudget (SPEC-038)', () => {
  it('caps a browser task and is keyed per task', () => {
    const s = new InMemoryBudgetStore();
    const b = browserTaskBudget('task-1', 200);
    expect(authorize(200, [b], s).status).toBe('ALLOWED');
    expect(authorize(1, [b], s).status).toBe('BUDGET_EXCEEDED');
    expect(browserTaskBudget('task-1', 1).key).not.toBe(browserTaskBudget('task-2', 1).key);
  });
});
