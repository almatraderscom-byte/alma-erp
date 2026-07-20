import { describe, it, expect } from 'vitest';
import { businessBudget } from '../scopes';
import { DEFAULT_BUDGET_LIMITS } from '../config';
import { InMemoryBudgetStore } from '../budget';
import { authorize } from '../../control-plane/cost/governor';

describe('businessBudget (SPEC-032)', () => {
  it('builds a business-scoped key isolated per business + month', () => {
    const life = businessBudget('alma', 'lifestyle', '2026-07', 1000);
    const trade = businessBudget('alma', 'trading', '2026-07', 1000);
    expect(life.scope).toBe('business');
    expect(life.key).not.toBe(trade.key);
  });

  it('is enforced by the governor', () => {
    const s = new InMemoryBudgetStore();
    const b = businessBudget('alma', 'lifestyle', '2026-07', 300);
    expect(authorize(200, [b], s).status).toBe('ALLOWED');
    expect(authorize(200, [b], s).status).toBe('BUDGET_EXCEEDED'); // 200 reserved + 200 > 300
  });

  it('ships an owner-tunable default limit (placeholder, not authoritative)', () => {
    const d = DEFAULT_BUDGET_LIMITS.business!;
    expect(d.ownerTunable).toBe(true);
    expect(d.limitNanoUsd).toBeGreaterThan(0);
    expect(d.note).toMatch(/placeholder/);
  });
});
