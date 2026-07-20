import { describe, it, expect } from 'vitest';
import { validateEscalation, ESCALATION_REASONS, FRONTIER_ELIGIBLE_REASONS, type EscalationRequest } from '../escalation-reason';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const esc = (over: Partial<EscalationRequest> = {}): EscalationRequest => ({
  identity, fromTier: 'T2', toTier: 'T3', reason: 'LOW_CONFIDENCE', ...over,
});

describe('SPEC-165 explicit escalation reason', () => {
  it('grants a valid upward escalation with a reason', () => {
    const res = validateEscalation(esc());
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.toTier).toBe('T3');
      expect(res.value.reason).toBe('LOW_CONFIDENCE');
      expect(res.value.toFrontier).toBe(false);
    }
  });

  it('rejects a missing/invalid reason (no implicit escalation)', () => {
    const res = validateEscalation(esc({ reason: 'GUESS' as never }));
    expect(res.status).toBe('DENIED');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('ESCALATION_REASON_REQUIRED');
  });

  it('rejects a non-upward move (equal or downward is not an escalation)', () => {
    expect(validateEscalation(esc({ fromTier: 'T3', toTier: 'T3' })).status).toBe('DENIED');
    expect(validateEscalation(esc({ fromTier: 'T3', toTier: 'T2' })).status).toBe('DENIED');
    const down = validateEscalation(esc({ fromTier: 'T3', toTier: 'T1' }));
    if (!isSuccess(down)) expect(down.reasonCodes).toContain('ESCALATION_NOT_UPWARD');
  });

  it('frontier (T4) needs a frontier-eligible reason', () => {
    const casual = validateEscalation(esc({ fromTier: 'T3', toTier: 'T4', reason: 'LOW_CONFIDENCE' }));
    expect(casual.status).toBe('DENIED');
    if (!isSuccess(casual)) expect(casual.reasonCodes).toContain('ESCALATION_FRONTIER_REASON_REQUIRED');

    for (const r of FRONTIER_ELIGIBLE_REASONS) {
      const ok = validateEscalation(esc({ fromTier: 'T3', toTier: 'T4', reason: r }));
      expect(isSuccess(ok)).toBe(true);
      if (isSuccess(ok)) expect(ok.value.toFrontier).toBe(true);
    }
  });

  it('LOW_CONFIDENCE and REPEATED_FAILURE are NOT frontier-eligible', () => {
    expect(FRONTIER_ELIGIBLE_REASONS).not.toContain('LOW_CONFIDENCE');
    expect(FRONTIER_ELIGIBLE_REASONS).not.toContain('REPEATED_FAILURE');
  });

  it('missing identity → FAILED_FINAL', () => {
    const res = validateEscalation(esc({ identity: { ...identity, tenantId: '' } }));
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('ESCALATION_MISSING_IDENTITY');
  });

  it('reason set is stable and finite', () => {
    expect([...ESCALATION_REASONS]).toEqual(['LOW_CONFIDENCE', 'REPEATED_FAILURE', 'HIGH_RISK_DECISION', 'BIG_MONEY', 'PLANNING_REQUIRED', 'OWNER_OVERRIDE']);
  });
});
