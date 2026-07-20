import { describe, it, expect } from 'vitest';
import { InMemoryBudgetStore, orgMonthlyBudget, type Reservation } from '../budget';
import { checkBudgetInvariant, lcg } from '../invariant';
import { authorize, settle, cancel } from '../../control-plane/cost/governor';

describe('overspend gate (SPEC-040) — the core safety property', () => {
  it('spent + reserved NEVER exceeds the limit across a long fuzzed sequence', () => {
    const store = new InMemoryBudgetStore();
    const budget = orgMonthlyBudget('alma', '2026-07', 10_000);
    const rand = lcg(42);
    const live: Reservation[] = [];

    for (let i = 0; i < 2000; i++) {
      // invariant must hold BEFORE and AFTER every operation
      expect(checkBudgetInvariant(store, budget).ok).toBe(true);
      const roll = rand();
      if (roll < 0.6) {
        const worst = Math.floor(rand() * 3000);
        const a = authorize(worst, [budget], store);
        if (a.status === 'ALLOWED') live.push(...a.value.reservations);
      } else if (roll < 0.85 && live.length) {
        const r = live.shift()!;
        // settle a random actual ≤ reserved
        const actual = Math.floor(rand() * (r.amountNanoUsd + 1));
        settle({ reservations: [r], worstCaseNanoUsd: r.amountNanoUsd }, actual, store);
      } else if (live.length) {
        const r = live.shift()!;
        cancel({ reservations: [r], worstCaseNanoUsd: r.amountNanoUsd }, store);
      }
      expect(checkBudgetInvariant(store, budget).ok).toBe(true);
    }

    const final = checkBudgetInvariant(store, budget);
    expect(final.ok).toBe(true);
    expect(final.spentNanoUsd).toBeLessThanOrEqual(final.limitNanoUsd);
  });

  it('a would-be overspend is refused, never silently allowed', () => {
    const store = new InMemoryBudgetStore();
    const budget = orgMonthlyBudget('alma', '2026-07', 100);
    expect(authorize(100, [budget], store).status).toBe('ALLOWED');
    // every further authorization is refused while the budget is full
    for (let i = 0; i < 50; i++) expect(authorize(1, [budget], store).status).toBe('BUDGET_EXCEEDED');
    expect(checkBudgetInvariant(store, budget).ok).toBe(true);
  });
});
