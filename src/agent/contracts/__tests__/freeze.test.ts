import { describe, it, expect } from 'vitest';
import {
  FREEZE_GATE_STEPS,
  REQUIRED_GATE_KINDS,
  coversAllKinds,
  freezeHolds,
} from '../freeze';
// Import the barrel to prove it resolves every contract module together.
import * as Contracts from '../index';

describe('freeze gate steps', () => {
  it('covers every required gate dimension', () => {
    expect(coversAllKinds(FREEZE_GATE_STEPS)).toBe(true);
    for (const k of REQUIRED_GATE_KINDS) {
      expect(FREEZE_GATE_STEPS.some((s) => s.kind === k)).toBe(true);
    }
  });

  it('marks every step mustPass', () => {
    for (const s of FREEZE_GATE_STEPS) expect(s.mustPass).toBe(true);
  });
});

describe('freezeHolds', () => {
  it('holds only when all steps pass', () => {
    expect(freezeHolds(FREEZE_GATE_STEPS.map((s) => ({ id: s.id, passed: true })))).toBe(true);
    expect(freezeHolds([{ id: 'a', passed: true }, { id: 'b', passed: false }])).toBe(false);
    expect(freezeHolds([])).toBe(false);
  });
});

describe('contracts barrel', () => {
  it('re-exports the full frozen surface', () => {
    // component
    expect(typeof Contracts.validateRequest).toBe('function');
    expect(Contracts.REASON_CODES.CROSS_TENANT).toBe('CROSS_TENANT');
    // invariants + ownership + identity + tenant + errors + adr + flag + proof
    expect(Contracts.ARCHITECTURE_INVARIANTS).toHaveLength(10);
    expect(typeof Contracts.resolveOwner).toBe('function');
    expect(typeof Contracts.createExecutionIdentity).toBe('function');
    expect(typeof Contracts.guardResourceAccess).toBe('function');
    expect(typeof Contracts.normalizeError).toBe('function');
    expect(typeof Contracts.lintAdrBody).toBe('function');
    expect(typeof Contracts.decide).toBe('function');
    expect(Contracts.REQUIRED_PROOF_ARTIFACTS).toHaveLength(10);
  });
});
