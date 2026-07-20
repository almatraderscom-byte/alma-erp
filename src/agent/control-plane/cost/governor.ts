/**
 * Hard Cost Governor — authorize / settle (G04 / SPEC-031).
 *
 * Realises INV-03: every model call is pre-authorised. `authorize` reserves the
 * worst-case cost against EVERY applicable budget (org → business → user → … →
 * model-call); if any scope would be exceeded, all prior reservations are
 * released and the call is DENIED (fail-closed). `settle` commits the actual cost
 * to every reservation after the call. Deterministic, integer nano-USD.
 */
import { REASON_CODES, allowed, failure, type ComponentResult } from '@/agent/contracts';
import type { Budget, BudgetStore, Reservation } from '@/agent/budgets/budget';

export const GOVERNOR_REASON_CODES = {
  NO_BUDGET: 'NO_BUDGET_CONFIGURED',
  BUDGET_EXCEEDED: REASON_CODES.BUDGET_EXCEEDED,
} as const;

export interface Authorization {
  reservations: Reservation[];
  worstCaseNanoUsd: number;
}

/**
 * Reserve worst-case cost against every budget. Fail-closed: an empty budget set
 * is a DENY (nothing authorised the call), and the first scope that cannot fit
 * denies the whole call after releasing already-made reservations.
 */
export function authorize(
  worstCaseNanoUsd: number,
  budgets: Budget[],
  store: BudgetStore,
): ComponentResult<Authorization> {
  if (budgets.length === 0) {
    // NO_BUDGET is a governor-local reason code (not in the canonical ReasonCode
    // union), so build the typed failure literally — reasonCodes is string[].
    return { status: 'DENIED', reasonCodes: [GOVERNOR_REASON_CODES.NO_BUDGET], evidenceIds: [] };
  }
  const made: Reservation[] = [];
  for (const budget of budgets) {
    const r = store.reserve(budget, worstCaseNanoUsd);
    if (r === null) {
      for (const done of made) store.release(done.id); // roll back — atomic
      return failure('BUDGET_EXCEEDED', [GOVERNOR_REASON_CODES.BUDGET_EXCEEDED], {
        evidenceIds: [`scope:${budget.scope}`, `key:${budget.key}`],
      });
    }
    made.push(r);
  }
  return allowed({ reservations: made, worstCaseNanoUsd }, made.map((m) => m.id));
}

/** Commit the actual cost to every reservation (call succeeded). */
export function settle(auth: Authorization, actualNanoUsd: number, store: BudgetStore): void {
  for (const r of auth.reservations) store.commit(r.id, actualNanoUsd);
}

/** Release every reservation (call did not happen / failed before spending). */
export function cancel(auth: Authorization, store: BudgetStore): void {
  for (const r of auth.reservations) store.release(r.id);
}
