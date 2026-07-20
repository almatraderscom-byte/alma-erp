/**
 * Budget invariant + overspend gate (G04 / SPEC-040).
 *
 * The safety property the whole Cost Governor exists to guarantee:
 *   spent + reserved ≤ limit,  for every budget, at every moment.
 * If that holds, overspend is impossible. This module lets tests assert it after
 * any sequence of operations. Deterministic, pure.
 */
import type { Budget, BudgetStore } from './budget';

export interface InvariantCheck {
  ok: boolean;
  key: string;
  spentNanoUsd: number;
  reservedNanoUsd: number;
  limitNanoUsd: number;
}

/** True iff spent + reserved ≤ limit for the budget. */
export function checkBudgetInvariant(store: BudgetStore, budget: Budget): InvariantCheck {
  const s = store.state(budget);
  return {
    ok: s.spentNanoUsd + s.reservedNanoUsd <= s.limitNanoUsd,
    key: budget.key,
    spentNanoUsd: s.spentNanoUsd,
    reservedNanoUsd: s.reservedNanoUsd,
    limitNanoUsd: s.limitNanoUsd,
  };
}

export function checkAll(store: BudgetStore, budgets: Budget[]): { ok: boolean; violations: InvariantCheck[] } {
  const checks = budgets.map((b) => checkBudgetInvariant(store, b));
  return { ok: checks.every((c) => c.ok), violations: checks.filter((c) => !c.ok) };
}

/** Deterministic LCG so the overspend fuzz is replayable (no Math.random). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
