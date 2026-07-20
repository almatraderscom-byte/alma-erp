import { describe, it, expect } from 'vitest';
import { isSuccess } from '@/agent/contracts';
import {
  emptyReplanState,
  requestReplan,
  recordStep,
  stepSignature,
  REPLAN_REASON_CODES,
  type ReplanCaps,
} from '../replan';

const caps: ReplanCaps = { maxReplans: 2, maxStalls: 2 };

describe('requestReplan (SPEC-148)', () => {
  it('allows replans under budget then hard-stops at the limit', () => {
    let s = emptyReplanState();
    const r1 = requestReplan(s, caps);
    expect(isSuccess(r1.result)).toBe(true);
    s = r1.state;
    const r2 = requestReplan(s, caps);
    expect(isSuccess(r2.result)).toBe(true);
    s = r2.state;
    // budget (2) now reached ⇒ next request denied
    const r3 = requestReplan(s, caps);
    expect(isSuccess(r3.result)).toBe(false);
    if (!isSuccess(r3.result)) {
      expect(r3.result.status).toBe('FAILED_FINAL');
      expect(r3.result.reasonCodes).toContain(REPLAN_REASON_CODES.REPLAN_LIMIT);
    }
  });

  it('rejects malformed caps (fail-closed)', () => {
    const r = requestReplan(emptyReplanState(), { maxReplans: -1, maxStalls: 2 });
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(REPLAN_REASON_CODES.MALFORMED);
  });
});

describe('recordStep — stall detection (SPEC-148)', () => {
  it('resets stalls on progress and counts stalls on repeats', () => {
    let s = emptyReplanState();
    const sig = stepSignature(0, 'hashA');

    let r = recordStep(s, sig, caps); // first observation, stalls 0
    expect(isSuccess(r.result)).toBe(true);
    if (isSuccess(r.result)) expect(r.result.value.stalls).toBe(0);
    s = r.state;

    r = recordStep(s, sig, caps); // same ⇒ stall 1
    if (isSuccess(r.result)) expect(r.result.value.stalls).toBe(1);
    s = r.state;

    r = recordStep(s, stepSignature(1, 'hashB'), caps); // progress ⇒ reset
    if (isSuccess(r.result)) expect(r.result.value.stalls).toBe(0);
    s = r.state;
  });

  it('hard-stops after exceeding maxStalls consecutive stalls', () => {
    let s = emptyReplanState();
    const sig = stepSignature(0, 'stuck');
    let last = recordStep(s, sig, caps);
    s = last.state; // stalls 0
    for (let i = 0; i < 3; i++) {
      last = recordStep(s, sig, caps);
      s = last.state;
    }
    // stalls went 1,2,3 → 3 > maxStalls(2) ⇒ STALLED
    expect(isSuccess(last.result)).toBe(false);
    if (!isSuccess(last.result)) {
      expect(last.result.status).toBe('FAILED_FINAL');
      expect(last.result.reasonCodes).toContain(REPLAN_REASON_CODES.STALLED);
    }
  });

  it('rejects an empty signature (fail-closed)', () => {
    const r = recordStep(emptyReplanState(), '', caps);
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(REPLAN_REASON_CODES.MALFORMED);
  });
});

describe('stepSignature', () => {
  it('is deterministic', () => {
    expect(stepSignature(3, 'h')).toBe('3:h');
    expect(stepSignature(3, 'h')).toBe(stepSignature(3, 'h'));
  });
});
