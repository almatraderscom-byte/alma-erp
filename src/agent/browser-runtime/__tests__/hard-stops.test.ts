import { describe, it, expect } from 'vitest';
import { isSuccess } from '@/agent/contracts';
import {
  emptyRunAccounting,
  admitStep,
  HARD_STOP_REASON_CODES,
  type BrowserRunBudget,
} from '../hard-stops';

const budget: BrowserRunBudget = { costCeilingNanoUsd: 1000, maxSteps: 3 };

describe('admitStep — cost + step hard-stops (SPEC-149)', () => {
  it('admits steps and advances integer nano-USD accounting', () => {
    let acc = emptyRunAccounting();
    const r = admitStep(acc, budget, 400);
    expect(isSuccess(r.result)).toBe(true);
    if (isSuccess(r.result)) {
      expect(r.result.value).toMatchObject({ spentNanoUsd: 400, steps: 1, remainingNanoUsd: 600, remainingSteps: 2 });
    }
    expect(r.accounting).toEqual({ spentNanoUsd: 400, steps: 1 });
  });

  it('hard-stops on the cost ceiling (BUDGET_EXCEEDED)', () => {
    const acc = { spentNanoUsd: 800, steps: 1 };
    const r = admitStep(acc, budget, 300); // 800+300=1100 > 1000
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) {
      expect(r.result.status).toBe('BUDGET_EXCEEDED');
      expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.COST_CEILING);
    }
    expect(r.accounting).toEqual(acc); // unchanged on stop
  });

  it('allows spend exactly at the ceiling', () => {
    const acc = { spentNanoUsd: 700, steps: 1 };
    const r = admitStep(acc, budget, 300); // exactly 1000
    expect(isSuccess(r.result)).toBe(true);
    if (isSuccess(r.result)) expect(r.result.value.remainingNanoUsd).toBe(0);
  });

  it('hard-stops on the step-count ceiling (STEP_LIMIT)', () => {
    const acc = { spentNanoUsd: 0, steps: 3 }; // already at maxSteps
    const r = admitStep(acc, budget, 1);
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) {
      expect(r.result.status).toBe('FAILED_FINAL');
      expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.STEP_LIMIT);
    }
  });

  it('rejects a non-integer (float) cost fail-closed', () => {
    const r = admitStep(emptyRunAccounting(), budget, 12.5);
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.MALFORMED);
  });

  it('rejects a negative cost fail-closed', () => {
    const r = admitStep(emptyRunAccounting(), budget, -1);
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.MALFORMED);
  });

  it('rejects a malformed budget fail-closed', () => {
    const r = admitStep(emptyRunAccounting(), { costCeilingNanoUsd: -5, maxSteps: 3 }, 10);
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.MALFORMED);
  });

  it('drives a run to exhaustion deterministically (step limit reached)', () => {
    let acc = emptyRunAccounting();
    const b: BrowserRunBudget = { costCeilingNanoUsd: 100000, maxSteps: 2 };
    acc = admitStep(acc, b, 10).accounting;
    acc = admitStep(acc, b, 10).accounting;
    const r = admitStep(acc, b, 10); // 3rd step over maxSteps=2
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(HARD_STOP_REASON_CODES.STEP_LIMIT);
  });
});
