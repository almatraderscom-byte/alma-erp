import { describe, it, expect } from 'vitest';
import { planCompensation, uncompensatableSteps } from '../saga';
import { initialState, applyEvent, type WorkflowInstanceState } from '../state';
import type { WorkflowTemplate } from '../registry';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const pin = { templateId: 'order', templateVersion: 1 };

// charge (side effect, compensated by refund) → ship (side effect, compensated by recall) → notify (no side effect)
const template: WorkflowTemplate = {
  id: 'order', version: 1,
  steps: [
    { id: 'charge', action: 'wallet.debit', sideEffect: true, onFailure: 'reconcile' },
    { id: 'ship', action: 'ship.create', sideEffect: true, onFailure: 'reconcile' },
    { id: 'notify', action: 'notify.send', sideEffect: false, onFailure: 'retryable' },
    { id: 'refund', action: 'wallet.refund', sideEffect: true, onFailure: 'terminal', compensates: 'charge' },
    { id: 'recall', action: 'ship.recall', sideEffect: true, onFailure: 'terminal', compensates: 'ship' },
  ],
};

function completeThrough(n: number): WorkflowInstanceState {
  let s = initialState(template, pin, identity, 'inst-1', 0);
  const order = ['charge', 'ship', 'notify'];
  for (let i = 0; i < n; i++) {
    const r1 = applyEvent(s, { type: 'STEP_STARTED', stepId: order[i], atMs: i * 2 + 1 });
    if (r1.ok) s = r1.state;
    const r2 = applyEvent(s, { type: 'STEP_COMPLETED', stepId: order[i], atMs: i * 2 + 2 });
    if (r2.ok) s = r2.state;
  }
  return s;
}

describe('planCompensation (SPEC-138)', () => {
  it('undoes committed side-effecting steps in reverse order', () => {
    const s = completeThrough(2); // charge + ship committed
    const plan = planCompensation(template, s);
    expect(plan.map((a) => a.forStepId)).toEqual(['ship', 'charge']); // reverse
    expect(plan[0]).toMatchObject({ compensateStepId: 'recall', action: 'ship.recall' });
    expect(plan[1]).toMatchObject({ compensateStepId: 'refund', action: 'wallet.refund' });
  });
  it('skips non-side-effecting completed steps', () => {
    const s = completeThrough(3); // + notify (no side effect)
    expect(planCompensation(template, s).map((a) => a.forStepId)).toEqual(['ship', 'charge']);
  });
  it('emits nothing when no side-effecting step has committed', () => {
    expect(planCompensation(template, completeThrough(0))).toEqual([]);
  });
  it('compensates only what actually committed', () => {
    const s = completeThrough(1); // only charge
    expect(planCompensation(template, s).map((a) => a.forStepId)).toEqual(['charge']);
  });
});

describe('uncompensatableSteps (SPEC-138)', () => {
  it('flags committed side-effecting steps with no compensator (manual recovery)', () => {
    const t: WorkflowTemplate = {
      id: 'x', version: 1,
      steps: [{ id: 'charge', action: 'wallet.debit', sideEffect: true, onFailure: 'reconcile' }],
    };
    let s = initialState(t, pin, identity, 'i', 0);
    s = (applyEvent(s, { type: 'STEP_STARTED', stepId: 'charge', atMs: 1 }) as { ok: true; state: WorkflowInstanceState }).state;
    s = (applyEvent(s, { type: 'STEP_COMPLETED', stepId: 'charge', atMs: 2 }) as { ok: true; state: WorkflowInstanceState }).state;
    expect(uncompensatableSteps(t, s)).toEqual(['charge']);
  });
});
