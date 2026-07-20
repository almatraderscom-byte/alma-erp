import { describe, it, expect } from 'vitest';
import { toolLoopBudget } from '../scopes';
import { InMemoryBudgetStore } from '../budget';
import { authorize, settle } from '../../control-plane/cost/governor';

describe('toolLoopBudget (SPEC-037)', () => {
  it('bounds a runaway loop: repeated calls stop once the loop cap is reached', () => {
    const s = new InMemoryBudgetStore();
    const b = toolLoopBudget('wf-1', 100);
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const a = authorize(30, [b], s);
      if (a.status !== 'ALLOWED') break;
      settle(a.value, 30, s);
      allowed++;
    }
    expect(allowed).toBe(3); // 3*30=90 ok, 4th (120) denied
  });
});
