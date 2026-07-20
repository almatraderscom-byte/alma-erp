/**
 * Budget engine with reserve → reconcile (G04 / SPEC-031).
 *
 * The money-safety core of the Cost Governor. Before a model call, the worst-case
 * cost (G03) is RESERVED against a budget; after the call the ACTUAL cost is
 * committed and the unused remainder released. Reservations mean concurrent calls
 * can never push a budget negative or overspend — the same guarantee the ERP
 * wallet needs. All amounts are integer nano-USD (USD only, no BDT).
 */
export type BudgetScope =
  | 'org'
  | 'business'
  | 'user'
  | 'workflow'
  | 'turn'
  | 'model_call'
  | 'tool_loop'
  | 'browser_task';

export interface Budget {
  scope: BudgetScope;
  key: string; // unique per scope instance, e.g. `org:alma:2026-07`
  limitNanoUsd: number;
}

export interface Reservation {
  id: string;
  key: string;
  amountNanoUsd: number;
}

export interface BudgetState {
  spentNanoUsd: number;
  reservedNanoUsd: number;
  limitNanoUsd: number;
  availableNanoUsd: number;
}

export interface BudgetStore {
  /** remaining = limit - spent - reserved (never negative) */
  available(budget: Budget): number;
  state(budget: Budget): BudgetState;
  /** Reserve worst-case cost. Returns a Reservation, or null if it would exceed. */
  reserve(budget: Budget, amountNanoUsd: number): Reservation | null;
  /** Convert a reservation to actual spend (actual clamped to reserved). */
  commit(reservationId: string, actualNanoUsd: number): void;
  /** Cancel a reservation without spending (the call did not happen). */
  release(reservationId: string): void;
}

interface Bucket {
  spent: number;
  reservations: Map<string, number>;
}

/** In-memory budget store. Durable store is the documented seam (proposed migration). */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly reservationKey = new Map<string, string>(); // reservationId -> budget key
  private counter = 0;

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { spent: 0, reservations: new Map() };
      this.buckets.set(key, b);
    }
    return b;
  }

  private reservedTotal(b: Bucket): number {
    let total = 0;
    for (const amt of b.reservations.values()) total += amt;
    return total;
  }

  available(budget: Budget): number {
    const b = this.bucket(budget.key);
    return Math.max(0, budget.limitNanoUsd - b.spent - this.reservedTotal(b));
  }

  state(budget: Budget): BudgetState {
    const b = this.bucket(budget.key);
    const reserved = this.reservedTotal(b);
    return {
      spentNanoUsd: b.spent,
      reservedNanoUsd: reserved,
      limitNanoUsd: budget.limitNanoUsd,
      availableNanoUsd: Math.max(0, budget.limitNanoUsd - b.spent - reserved),
    };
  }

  reserve(budget: Budget, amountNanoUsd: number): Reservation | null {
    const amt = Math.max(0, Math.round(amountNanoUsd));
    const b = this.bucket(budget.key);
    if (b.spent + this.reservedTotal(b) + amt > budget.limitNanoUsd) {
      return null; // would exceed — fail closed
    }
    const id = `rsv_${budget.key}_${++this.counter}`;
    b.reservations.set(id, amt);
    this.reservationKey.set(id, budget.key);
    return { id, key: budget.key, amountNanoUsd: amt };
  }

  commit(reservationId: string, actualNanoUsd: number): void {
    const key = this.reservationKey.get(reservationId);
    if (key === undefined) return;
    const b = this.bucket(key);
    const reserved = b.reservations.get(reservationId) ?? 0;
    // Actual can never exceed the reserved worst-case (clamp defends the invariant).
    const actual = Math.min(Math.max(0, Math.round(actualNanoUsd)), reserved);
    b.spent += actual;
    b.reservations.delete(reservationId);
    this.reservationKey.delete(reservationId);
  }

  release(reservationId: string): void {
    const key = this.reservationKey.get(reservationId);
    if (key === undefined) return;
    this.bucket(key).reservations.delete(reservationId);
    this.reservationKey.delete(reservationId);
  }
}

/** Build an org monthly budget key: `org:<tenant>:<YYYY-MM>` (SPEC-031). */
export function orgMonthlyBudget(tenantId: string, yearMonth: string, limitNanoUsd: number): Budget {
  return { scope: 'org', key: `org:${tenantId}:${yearMonth}`, limitNanoUsd };
}
