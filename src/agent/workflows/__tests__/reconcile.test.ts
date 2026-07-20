import { describe, it, expect } from 'vitest';
import { reconcile, reconcileWith, RECONCILE_REASON_CODES, type Reconciler, type ReconcileFinding } from '../reconcile';

const budget = { attempts: 1, maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 5000 };

describe('reconcile (SPEC-137)', () => {
  it('CONFIRMED_DONE when the effect is present', () => {
    expect(reconcile({ ...budget, finding: 'effect_present' }).action).toBe('CONFIRMED_DONE');
  });
  it('CONFIRMED_NOT_DONE when the effect is absent (safe to retry)', () => {
    expect(reconcile({ ...budget, finding: 'effect_absent' }).action).toBe('CONFIRMED_NOT_DONE');
  });
  it('RECONCILE_AGAIN with backoff while indeterminate within budget', () => {
    const r = reconcile({ ...budget, finding: 'indeterminate', attempts: 1 });
    expect(r.action).toBe('RECONCILE_AGAIN');
    if (r.action === 'RECONCILE_AGAIN') { expect(r.nextAttempt).toBe(2); expect(r.backoffMs).toBe(200); }
  });
  it('ESCALATEs an indeterminate outcome once the budget is exhausted (never guesses)', () => {
    const r = reconcile({ ...budget, finding: 'indeterminate', attempts: 3, maxAttempts: 3 });
    expect(r.action).toBe('ESCALATE');
    if (r.action === 'ESCALATE') expect(r.reasonCode).toBe(RECONCILE_REASON_CODES.INDETERMINATE_EXHAUSTED);
  });
  it('ESCALATEs on malformed budget (fail-closed)', () => {
    expect(reconcile({ ...budget, finding: 'effect_present', attempts: 0 }).action).toBe('ESCALATE');
  });
});

describe('reconcileWith (SPEC-137)', () => {
  const fake = (f: ReconcileFinding): Reconciler => ({ name: 'fake', probe: () => f });
  it('drives the decision from a probe finding', () => {
    expect(reconcileWith(fake('effect_present'), 'idem_x', budget).action).toBe('CONFIRMED_DONE');
    expect(reconcileWith(fake('effect_absent'), 'idem_x', budget).action).toBe('CONFIRMED_NOT_DONE');
  });
  it('treats a throwing probe as indeterminate (never as done)', () => {
    const boom: Reconciler = { name: 'boom', probe: () => { throw new Error('down'); } };
    const r = reconcileWith(boom, 'idem_x', budget);
    expect(r.action).toBe('RECONCILE_AGAIN'); // indeterminate, attempts remain
  });
});
