import { describe, it, expect } from 'vitest';
import { initialState, applyEvent, replay, currentStepId, STATE_REASON_CODES, type WorkflowInstanceState, type WorkflowEvent } from '../state';
import type { WorkflowTemplate } from '../registry';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const template: WorkflowTemplate = {
  id: 'wf', version: 1,
  steps: [
    { id: 'a', action: 'x', sideEffect: false, onFailure: 'retryable' },
    { id: 'b', action: 'y', sideEffect: true, onFailure: 'reconcile' },
  ],
};
const pin = { templateId: 'wf', templateVersion: 1 };
const init = (): WorkflowInstanceState => initialState(template, pin, identity, 'inst-1', 1000);

const ok = (r: ReturnType<typeof applyEvent>): WorkflowInstanceState => {
  if (!r.ok) throw new Error('expected ok: ' + r.reasonCodes.join());
  return r.state;
};

describe('initialState (SPEC-133)', () => {
  it('starts running, cursor 0, all steps pending', () => {
    const s = init();
    expect(s.status).toBe('running');
    expect(s.cursor).toBe(0);
    expect(s.steps.map((x) => x.status)).toEqual(['pending', 'pending']);
    expect(currentStepId(s)).toBe('a');
  });
});

describe('applyEvent happy path (SPEC-133)', () => {
  it('runs a full instance to completed', () => {
    let s = init();
    s = ok(applyEvent(s, { type: 'STEP_STARTED', stepId: 'a', atMs: 1001 }));
    expect(s.steps[0].status).toBe('running');
    expect(s.steps[0].attempts).toBe(1);
    s = ok(applyEvent(s, { type: 'STEP_COMPLETED', stepId: 'a', atMs: 1002 }));
    expect(s.cursor).toBe(1);
    expect(currentStepId(s)).toBe('b');
    s = ok(applyEvent(s, { type: 'STEP_STARTED', stepId: 'b', atMs: 1003 }));
    s = ok(applyEvent(s, { type: 'STEP_COMPLETED', stepId: 'b', atMs: 1004 }));
    expect(s.status).toBe('completed');
    expect(s.cursor).toBe(2);
    expect(currentStepId(s)).toBeNull();
  });

  it('records a step failure without advancing (retry left to a later spec)', () => {
    let s = init();
    s = ok(applyEvent(s, { type: 'STEP_STARTED', stepId: 'a', atMs: 1001 }));
    s = ok(applyEvent(s, { type: 'STEP_FAILED', stepId: 'a', error: 'boom', atMs: 1002 }));
    expect(s.steps[0].status).toBe('failed');
    expect(s.steps[0].lastError).toBe('boom');
    expect(s.status).toBe('running');
    expect(s.cursor).toBe(0);
    // a retry: STEP_STARTED again bumps attempts
    s = ok(applyEvent(s, { type: 'STEP_STARTED', stepId: 'a', atMs: 1003 }));
    expect(s.steps[0].attempts).toBe(2);
  });
});

describe('applyEvent fail-closed guards (SPEC-133)', () => {
  it('rejects an event for an unknown step', () => {
    const r = applyEvent(init(), { type: 'STEP_STARTED', stepId: 'ghost', atMs: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCodes).toContain(STATE_REASON_CODES.UNKNOWN_STEP);
  });
  it('rejects an event for a non-current step', () => {
    const r = applyEvent(init(), { type: 'STEP_STARTED', stepId: 'b', atMs: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCodes).toContain(STATE_REASON_CODES.NOT_CURRENT_STEP);
  });
  it('rejects completing a step that is not running', () => {
    const r = applyEvent(init(), { type: 'STEP_COMPLETED', stepId: 'a', atMs: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCodes).toContain(STATE_REASON_CODES.ILLEGAL_TRANSITION);
  });
  it('does not mutate the input state on success or rejection', () => {
    const s = init();
    applyEvent(s, { type: 'STEP_STARTED', stepId: 'a', atMs: 1 });
    expect(s.steps[0].status).toBe('pending'); // unchanged
    applyEvent(s, { type: 'STEP_COMPLETED', stepId: 'a', atMs: 1 }); // rejected
    expect(s.steps[0].status).toBe('pending');
  });
  it('forbids step progress once completed (terminal)', () => {
    const done = replay(init(), [
      { type: 'STEP_STARTED', stepId: 'a', atMs: 1 }, { type: 'STEP_COMPLETED', stepId: 'a', atMs: 2 },
      { type: 'STEP_STARTED', stepId: 'b', atMs: 3 }, { type: 'STEP_COMPLETED', stepId: 'b', atMs: 4 },
    ]);
    expect(done.ok).toBe(true);
    if (done.ok) {
      const r = applyEvent(done.state, { type: 'STEP_STARTED', stepId: 'a', atMs: 5 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonCodes).toContain(STATE_REASON_CODES.ALREADY_TERMINAL);
    }
  });
});

describe('replay (SPEC-133)', () => {
  it('is deterministic — replaying a log rebuilds the same state', () => {
    const events: WorkflowEvent[] = [
      { type: 'STEP_STARTED', stepId: 'a', atMs: 1 }, { type: 'STEP_COMPLETED', stepId: 'a', atMs: 2 },
    ];
    const a = replay(init(), events);
    const b = replay(init(), events);
    expect(a).toEqual(b);
  });
  it('WORKFLOW_FAILED marks the instance failed', () => {
    const r = applyEvent(init(), { type: 'WORKFLOW_FAILED', atMs: 9 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.status).toBe('failed');
  });
});
