import { describe, it, expect } from 'vitest';
import { userBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize } from '../../control-plane/cost/governor';

describe('userBudget (SPEC-033)', () => {
  it('isolates per actor + month', () => {
    expect(userBudget('alma', 'maruf', '2026-07', 100).key).not.toBe(userBudget('alma', 'staff1', '2026-07', 100).key);
  });
  it('is enforced by the governor (fail-closed past limit)', () => {
    const s = new InMemoryBudgetStore();
    const b = userBudget('alma', 'maruf', '2026-07', 100);
    expect(authorize(80, [b], s).status).toBe('ALLOWED');
    expect(authorize(80, [b], s).status).toBe('BUDGET_EXCEEDED');
  });
});
