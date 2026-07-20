import { describe, it, expect } from 'vitest';
import { InMemoryBudgetStore, orgMonthlyBudget } from '../budget';

const B = orgMonthlyBudget('alma', '2026-07', 1000);

describe('reserve → commit / release (overspend safety)', () => {
  it('reserves within the limit and reports availability', () => {
    const s = new InMemoryBudgetStore();
    const r = s.reserve(B, 400);
    expect(r).not.toBeNull();
    expect(s.available(B)).toBe(600); // 1000 - 400 reserved
  });

  it('DENIES a reservation that would exceed the limit (fail-closed)', () => {
    const s = new InMemoryBudgetStore();
    s.reserve(B, 800);
    expect(s.reserve(B, 300)).toBeNull(); // 800+300 > 1000
    expect(s.available(B)).toBe(200);
  });

  it('commit moves reserved → spent using the ACTUAL (≤ reserved)', () => {
    const s = new InMemoryBudgetStore();
    const r = s.reserve(B, 500)!; // reserve worst case 500
    s.commit(r.id, 120); // actual only 120
    const st = s.state(B);
    expect(st.spentNanoUsd).toBe(120);
    expect(st.reservedNanoUsd).toBe(0);
    expect(st.availableNanoUsd).toBe(880); // unused 380 released back
  });

  it('actual can never exceed reserved (clamp defends the invariant)', () => {
    const s = new InMemoryBudgetStore();
    const r = s.reserve(B, 100)!;
    s.commit(r.id, 999999); // buggy caller reports more than reserved
    expect(s.state(B).spentNanoUsd).toBe(100); // clamped to reserved
  });

  it('release frees a reservation without spending', () => {
    const s = new InMemoryBudgetStore();
    const r = s.reserve(B, 700)!;
    s.release(r.id);
    expect(s.available(B)).toBe(1000);
    expect(s.state(B).spentNanoUsd).toBe(0);
  });

  it('concurrent reservations cannot collectively overspend', () => {
    const s = new InMemoryBudgetStore();
    // three callers each reserve 400 against a 1000 budget
    const a = s.reserve(B, 400);
    const b = s.reserve(B, 400);
    const c = s.reserve(B, 400); // 1200 > 1000 -> must be denied
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    // even after commits, spent never exceeds the limit
    s.commit(a!.id, 400);
    s.commit(b!.id, 400);
    expect(s.state(B).spentNanoUsd).toBe(800);
    expect(s.available(B)).toBe(200);
  });

  it('budgets are isolated by key (month/tenant)', () => {
    const s = new InMemoryBudgetStore();
    const july = orgMonthlyBudget('alma', '2026-07', 1000);
    const august = orgMonthlyBudget('alma', '2026-08', 1000);
    s.reserve(july, 1000);
    expect(s.available(july)).toBe(0);
    expect(s.available(august)).toBe(1000); // separate bucket
  });
});
