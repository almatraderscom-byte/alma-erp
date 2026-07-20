import { describe, it, expect } from 'vitest';
import { workflowBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize, settle } from '../../control-plane/cost/governor';

describe('workflowBudget (SPEC-034)', () => {
  it('caps total spend across a workflow run', () => {
    const s = new InMemoryBudgetStore();
    const b = workflowBudget('wf-1', 100);
    const a = authorize(60, [b], s);
    if (a.status !== 'ALLOWED') throw new Error('expected ALLOWED');
    settle(a.value, 60, s); // actual 60 spent
    // next call worst-case 60 -> 60 spent + 60 > 100 -> denied
    expect(authorize(60, [b], s).status).toBe('BUDGET_EXCEEDED');
  });
  it('is isolated per workflow', () => {
    expect(workflowBudget('wf-1', 1).key).not.toBe(workflowBudget('wf-2', 1).key);
  });
});
