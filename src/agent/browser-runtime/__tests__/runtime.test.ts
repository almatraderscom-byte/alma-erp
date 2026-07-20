import { describe, it, expect } from 'vitest';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import { validatePlan, validateObservation, resolveTarget, decideAction } from '../runtime';
import {
  BROWSER_REASON_CODES,
  type BrowserPlan,
  type Observation,
  type PlanStep,
} from '../contract';

const identity = (): ExecutionIdentity => ({
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const plan = (steps: PlanStep[]): BrowserPlan => ({ planId: 'p1', identity: identity(), goalId: 'g1', steps });

const obs = (elements: Observation['elements']): Observation => ({
  identity: identity(),
  observedAtMs: 1000,
  urlRef: 'example.com/orders',
  elements,
});

describe('validatePlan (SPEC-146)', () => {
  it('accepts a well-formed plan', () => {
    const r = validatePlan(plan([{ stepIndex: 0, intent: 'click', targetHint: 'Submit' }]));
    expect(isSuccess(r)).toBe(true);
  });
  it('rejects a malformed plan (fail-closed)', () => {
    const r = validatePlan({ planId: '', identity: identity(), goalId: 'g', steps: [] });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.PLAN_MALFORMED);
  });
  it('rejects an over-long plan', () => {
    const steps: PlanStep[] = Array.from({ length: 40 }, (_, i) => ({ stepIndex: i, intent: 'read', targetHint: 'x' }));
    const r = validatePlan(plan(steps));
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.PLAN_MALFORMED);
  });
});

describe('validateObservation (SPEC-146)', () => {
  it('accepts a bounded observation', () => {
    expect(isSuccess(validateObservation(obs([{ ref: 'e1', role: 'button', label: 'Submit' }])))).toBe(true);
  });
  it('rejects a malformed observation', () => {
    const r = validateObservation({ identity: identity(), observedAtMs: -1, urlRef: 'x', elements: [] });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.OBS_MALFORMED);
  });
});

describe('resolveTarget (SPEC-146)', () => {
  it('returns the ref for a matching label, null otherwise', () => {
    const o = obs([{ ref: 'e1', role: 'button', label: 'Submit' }]);
    expect(resolveTarget(o, 'Submit')).toBe('e1');
    expect(resolveTarget(o, 'Cancel')).toBeNull();
  });
});

describe('decideAction — plan/perception/action separation (SPEC-146)', () => {
  it('mints a click action only when the target is present in the perception', () => {
    const p = plan([{ stepIndex: 0, intent: 'click', targetHint: 'Submit' }]);
    const o = obs([{ ref: 'e1', role: 'button', label: 'Submit' }]);
    const r = decideAction(p, o, 0);
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) expect(r.value).toMatchObject({ type: 'click', planStepIndex: 0, targetRef: 'e1' });
  });

  it('DENIES an action whose target is NOT in the perception (anti-hallucination)', () => {
    const p = plan([{ stepIndex: 0, intent: 'click', targetHint: 'DeleteEverything' }]);
    const o = obs([{ ref: 'e1', role: 'button', label: 'Submit' }]);
    const r = decideAction(p, o, 0);
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) {
      expect(r.status).toBe('DENIED');
      expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.TARGET_NOT_FOUND);
    }
  });

  it('DENIES a click/type step with no targetHint', () => {
    const p = plan([{ stepIndex: 0, intent: 'type' }]);
    const r = decideAction(p, obs([]), 0);
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.MISSING_TARGET_HINT);
  });

  it('allows a navigate step without a page target', () => {
    const p = plan([{ stepIndex: 0, intent: 'navigate', url: 'example.com' }]);
    const r = decideAction(p, obs([]), 0);
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) expect(r.value.type).toBe('navigate');
  });

  it('returns a terminal stop when the plan is exhausted', () => {
    const p = plan([{ stepIndex: 0, intent: 'read', targetHint: 'x' }]);
    const r = decideAction(p, obs([]), 1);
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) expect(r.value.type).toBe('stop');
  });

  it('carries the typed text on a type action', () => {
    const p = plan([{ stepIndex: 0, intent: 'type', targetHint: 'Search', text: 'shoes' }]);
    const o = obs([{ ref: 'in1', role: 'textbox', label: 'Search' }]);
    const r = decideAction(p, o, 0);
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) expect(r.value).toMatchObject({ type: 'type', targetRef: 'in1', text: 'shoes' });
  });

  it('rejects a malformed cursor (fail-closed)', () => {
    const p = plan([{ stepIndex: 0, intent: 'read', targetHint: 'x' }]);
    const r = decideAction(p, obs([]), -1);
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(BROWSER_REASON_CODES.MALFORMED);
  });
});
