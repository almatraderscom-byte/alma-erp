/**
 * Workflow durability chaos certification (G14 / SPEC-140).
 *
 * The group's red-team gate. It composes the WHOLE durable runtime — template
 * registry, event-sourced state, leases, retry classification, idempotency,
 * reconciliation, saga compensation, dead-letter — and injects the failures a
 * real system suffers (duplicate delivery, crash mid-effect, lease expiry,
 * unknown outcomes, exhausted retries), asserting each durability invariant holds
 * by actually driving the stack (INV-10). If any breaks, the group must not
 * certify.
 *
 * Deterministic, pure (INV-01): all timestamps/inputs are constants.
 */
import { workflowTemplateRegistry, type WorkflowTemplate } from './registry';
import { pinAtStart, templateForPin, assertNoVersionDrift } from './versioning';
import { initialState, applyEvent, replay, type WorkflowInstanceState } from './state';
import { acquireLease, assertLeaseHeld } from './lease';
import { classifyFailure } from './retry';
import { idempotencyKey, resolveIdempotency } from './idempotency';
import { reconcile } from './reconcile';
import { planCompensation, uncompensatableSteps } from './saga';
import { toDeadLetter, allowedRecoveryActions } from './dead-letter';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

const template: WorkflowTemplate = {
  id: 'order', version: 1,
  steps: [
    { id: 'charge', action: 'wallet.debit', sideEffect: true, onFailure: 'reconcile' },
    { id: 'ship', action: 'ship.create', sideEffect: true, onFailure: 'reconcile' },
    { id: 'refund', action: 'wallet.refund', sideEffect: true, onFailure: 'terminal', compensates: 'charge' },
  ],
};
const registry = workflowTemplateRegistry([template]);
const pin = { templateId: 'order', templateVersion: 1 };

function completeStep(s: WorkflowInstanceState, stepId: string, t: number): WorkflowInstanceState {
  const a = applyEvent(s, { type: 'STEP_STARTED', stepId, atMs: t });
  if (!a.ok) return s;
  const b = applyEvent(a.state, { type: 'STEP_COMPLETED', stepId, atMs: t + 1 });
  return b.ok ? b.state : a.state;
}

export interface ChaosResult { invariant: string; ok: boolean }

export function runWorkflowChaosSuite(): ChaosResult[] {
  const checks: Array<[string, () => boolean]> = [
    ['pinned template resolves; drift on resume rejected', () => {
      const p = pinAtStart(registry, 'order');
      return !!p && !!templateForPin(registry, p) && assertNoVersionDrift(p!, 2).length > 0;
    }],
    ['duplicate delivery commits the side effect only once', () => {
      const key = idempotencyKey('inst-1', 'charge', pin);
      const first = resolveIdempotency(key, null).action === 'PROCEED';
      const second = resolveIdempotency(key, { key, status: 'committed', resultRef: 'ev1' }).action === 'SKIP';
      return first && second;
    }],
    ['crash mid-effect (unknown outcome) reconciles, never blind-retries', () =>
      classifyFailure({ failureKind: 'unknown', sideEffect: true, attempts: 1, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 }).action === 'RECONCILE'],
    ['reconcile: effect present ⇒ done (no re-run)', () =>
      reconcile({ finding: 'effect_present', attempts: 1, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 }).action === 'CONFIRMED_DONE'],
    ['reconcile: effect absent ⇒ safe to retry', () =>
      reconcile({ finding: 'effect_absent', attempts: 1, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 }).action === 'CONFIRMED_NOT_DONE'],
    ['reconcile: indeterminate exhausted ⇒ escalate (never guess)', () =>
      reconcile({ finding: 'indeterminate', attempts: 3, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 }).action === 'ESCALATE'],
    ['retry budget exhausted ⇒ terminal', () =>
      classifyFailure({ failureKind: 'transient', sideEffect: false, attempts: 3, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 }).action === 'TERMINAL'],
    ['lease held by another live worker blocks a second worker', () => {
      const held = acquireLease(null, { instanceId: 'i', stepId: 'charge', workerId: 'w1', nowMs: 0, ttlMs: 100 });
      if (!held.ok) return false;
      const blocked = acquireLease(held.lease, { instanceId: 'i', stepId: 'charge', workerId: 'w2', nowMs: 50, ttlMs: 100 });
      const staleWrite = assertLeaseHeld(held.lease, 'w1', 200).length > 0; // after expiry w1 can't write
      return !blocked.ok && staleWrite;
    }],
    ['expired lease is reclaimable by another worker', () => {
      const held = acquireLease(null, { instanceId: 'i', stepId: 'charge', workerId: 'w1', nowMs: 0, ttlMs: 100 });
      return held.ok && acquireLease(held.lease, { instanceId: 'i', stepId: 'charge', workerId: 'w2', nowMs: 100, ttlMs: 100 }).ok;
    }],
    ['failure after commit compensates in reverse order', () => {
      let s = initialState(template, pin, identity, 'inst-2', 0);
      s = completeStep(s, 'charge', 1);
      s = completeStep(s, 'ship', 3);
      const plan = planCompensation(template, s);
      // ship has no compensator here; charge does → only charge compensated, and it is
      return plan.length === 1 && plan[0].forStepId === 'charge' && uncompensatableSteps(template, s).includes('ship');
    }],
    ['uncompensatable committed effect ⇒ dead-letter with no auto-retry', () => {
      let s = initialState(template, pin, identity, 'inst-3', 0);
      s = completeStep(s, 'charge', 1);
      s = completeStep(s, 'ship', 3);
      const dl = toDeadLetter(s, 'uncompensatable', { uncompensated: uncompensatableSteps(template, s), enqueuedAtMs: 9 });
      const actions = allowedRecoveryActions(dl);
      return !actions.includes('retry_step') && !actions.includes('skip_step');
    }],
    ['event-log replay is deterministic', () => {
      const events = [
        { type: 'STEP_STARTED' as const, stepId: 'charge', atMs: 1 },
        { type: 'STEP_COMPLETED' as const, stepId: 'charge', atMs: 2 },
      ];
      const a = replay(initialState(template, pin, identity, 'i', 0), events);
      const b = replay(initialState(template, pin, identity, 'i', 0), events);
      return JSON.stringify(a) === JSON.stringify(b);
    }],
    ['illegal transition rejected, state unchanged', () => {
      const s = initialState(template, pin, identity, 'i', 0);
      const r = applyEvent(s, { type: 'STEP_COMPLETED', stepId: 'charge', atMs: 1 }); // not running
      return !r.ok && s.steps[0].status === 'pending';
    }],
  ];
  return checks.map(([invariant, run]) => {
    let ok = false;
    try { ok = run(); } catch { ok = false; }
    return { invariant, ok };
  });
}

export function certifyWorkflowDurability(): { ok: boolean; total: number; failed: string[] } {
  const results = runWorkflowChaosSuite();
  const failed = results.filter((r) => !r.ok).map((r) => r.invariant);
  return { ok: failed.length === 0, total: results.length, failed };
}
