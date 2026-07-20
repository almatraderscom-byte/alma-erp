import { describe, it, expect } from 'vitest';
import { authorize, cancel, settle, GOVERNOR_REASON_CODES } from '../governor';
import { InMemoryBudgetStore, orgMonthlyBudget, type Budget } from '@/agent/budgets/budget';

const org = orgMonthlyBudget('alma', '2026-07', 1000);
const user: Budget = { scope: 'user', key: 'user:maruf:2026-07', limitNanoUsd: 300 };

describe('authorize (INV-03: pre-authorise every call)', () => {
  it('DENIES when no budget is configured (fail-closed)', () => {
    const s = new InMemoryBudgetStore();
    const r = authorize(100, [], s);
    expect(r.status).toBe('DENIED');
    if ('reasonCodes' in r) expect(r.reasonCodes).toContain(GOVERNOR_REASON_CODES.NO_BUDGET);
  });

  it('ALLOWS and reserves against every budget when all fit', () => {
    const s = new InMemoryBudgetStore();
    const r = authorize(200, [org, user], s);
    expect(r.status).toBe('ALLOWED');
    expect(s.available(org)).toBe(800);
    expect(s.available(user)).toBe(100);
  });

  it('DENIES with BUDGET_EXCEEDED when ANY scope cannot fit, and rolls back others', () => {
    const s = new InMemoryBudgetStore();
    // 500 fits org (1000) but not user (300) -> whole call denied, org reservation rolled back
    const r = authorize(500, [org, user], s);
    expect(r.status).toBe('BUDGET_EXCEEDED');
    expect(s.available(org)).toBe(1000); // org reservation was released (atomic)
    expect(s.available(user)).toBe(300);
  });

  it('settle commits actual to every scope; unused worst-case is released', () => {
    const s = new InMemoryBudgetStore();
    const r = authorize(200, [org, user], s); // reserve worst-case 200 each
    if (r.status !== 'ALLOWED') throw new Error('expected ALLOWED');
    settle(r.value, 50, s); // actual 50
    expect(s.state(org).spentNanoUsd).toBe(50);
    expect(s.state(user).spentNanoUsd).toBe(50);
    expect(s.available(org)).toBe(950);
  });

  it('cancel releases all reservations (call did not happen)', () => {
    const s = new InMemoryBudgetStore();
    const r = authorize(200, [org, user], s);
    if (r.status !== 'ALLOWED') throw new Error('expected ALLOWED');
    cancel(r.value, s);
    expect(s.available(org)).toBe(1000);
    expect(s.available(user)).toBe(300);
  });
});
