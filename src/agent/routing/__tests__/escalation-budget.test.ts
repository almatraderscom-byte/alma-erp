import { describe, it, expect } from 'vitest';
import { enforceEscalation, createInMemoryEscalationBudget } from '../escalation-budget';
import { fixedClock } from '@/agent/models';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import type { EscalationRequest } from '../escalation-reason';

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const esc = (over: Partial<EscalationRequest> = {}): EscalationRequest => ({
  identity, fromTier: 'T2', toTier: 'T3', reason: 'LOW_CONFIDENCE', ...over,
});
const frontier = (): EscalationRequest => esc({ fromTier: 'T3', toTier: 'T4', reason: 'BIG_MONEY' });

describe('SPEC-166 escalation budget enforcement', () => {
  it('grants a legal escalation within budget', () => {
    const deps = { budget: createInMemoryEscalationBudget({ maxEscalationsPerDay: 5, maxFrontierPerDay: 2 }), clock: fixedClock(0) };
    const res = enforceEscalation(esc(), deps);
    expect(isSuccess(res)).toBe(true);
  });

  it('passes through the SPEC-165 reason failure (no budget consumed)', () => {
    const budget = createInMemoryEscalationBudget();
    const deps = { budget, clock: fixedClock(0) };
    const res = enforceEscalation(esc({ reason: 'NOPE' as never }), deps);
    expect(res.status).toBe('DENIED');
    // budget not consumed → a subsequent valid call still succeeds
    expect(isSuccess(enforceEscalation(esc(), deps))).toBe(true);
  });

  it('enforces the general daily cap → BUDGET_EXCEEDED', () => {
    const deps = { budget: createInMemoryEscalationBudget({ maxEscalationsPerDay: 2, maxFrontierPerDay: 5 }), clock: fixedClock(0) };
    expect(enforceEscalation(esc(), deps).status).toBe('COMPLETED');
    expect(enforceEscalation(esc(), deps).status).toBe('COMPLETED');
    const third = enforceEscalation(esc(), deps);
    expect(third.status).toBe('BUDGET_EXCEEDED');
    if (!isSuccess(third)) expect(third.reasonCodes).toContain('ESCALATION_DAILY_CAP_EXCEEDED');
  });

  it('enforces a stricter frontier cap (and frontier consumes both counters)', () => {
    const deps = { budget: createInMemoryEscalationBudget({ maxEscalationsPerDay: 20, maxFrontierPerDay: 1 }), clock: fixedClock(0) };
    expect(enforceEscalation(frontier(), deps).status).toBe('COMPLETED');
    const second = enforceEscalation(frontier(), deps);
    expect(second.status).toBe('BUDGET_EXCEEDED');
    if (!isSuccess(second)) expect(second.reasonCodes).toContain('ESCALATION_FRONTIER_DAILY_CAP_EXCEEDED');
  });

  it('caps are per-actor and reset on a new day (clock-driven)', () => {
    const budget = createInMemoryEscalationBudget({ maxEscalationsPerDay: 1, maxFrontierPerDay: 5 });
    const clock = fixedClock(0);
    const deps = { budget, clock };
    expect(enforceEscalation(esc(), deps).status).toBe('COMPLETED');
    expect(enforceEscalation(esc(), deps).status).toBe('BUDGET_EXCEEDED'); // cap hit same day
    // different actor unaffected
    expect(enforceEscalation(esc({ identity: { ...identity, actorId: 'staff:2' } }), deps).status).toBe('COMPLETED');
    // new day resets
    clock.advance(86_400_000);
    expect(enforceEscalation(esc(), deps).status).toBe('COMPLETED');
  });
});
