import { describe, it, expect } from 'vitest';
import {
  REQUIRED_PROOF_ARTIFACTS,
  isAdvanceable,
  validateProof,
  verdictOf,
} from '../proof-artifact';

const ALL = [...REQUIRED_PROOF_ARTIFACTS];

describe('REQUIRED_PROOF_ARTIFACTS', () => {
  it('lists the ten canonical artifacts', () => {
    expect(REQUIRED_PROOF_ARTIFACTS).toHaveLength(10);
    expect(REQUIRED_PROOF_ARTIFACTS).toContain('final-verdict.md');
    expect(REQUIRED_PROOF_ARTIFACTS).toContain('rollback-proof.md');
  });
});

describe('verdictOf', () => {
  it('reads PASS/PARTIAL/FAIL, bolded or not', () => {
    expect(verdictOf('**Verdict: PASS**')).toBe('PASS');
    expect(verdictOf('Verdict:  PARTIAL')).toBe('PARTIAL');
    expect(verdictOf('# x\nVerdict: FAIL\n')).toBe('FAIL');
    expect(verdictOf('no verdict here')).toBeNull();
  });
});

describe('validateProof', () => {
  it('passes a complete PASS proof dir', () => {
    const v = validateProof(ALL, '**Verdict: PASS**');
    expect(v.complete).toBe(true);
    expect(v.verdict).toBe('PASS');
    expect(v.issues).toEqual([]);
    expect(isAdvanceable(v)).toBe(true);
  });

  it('flags a missing artifact', () => {
    const v = validateProof(ALL.filter((f) => f !== 'rollback-proof.md'), '**Verdict: PASS**');
    expect(v.complete).toBe(false);
    expect(v.issues.some((i) => i.code === 'MISSING_ARTIFACT' && i.detail === 'rollback-proof.md')).toBe(true);
    expect(isAdvanceable(v)).toBe(false);
  });

  it('flags a missing verdict', () => {
    const v = validateProof(ALL, 'nothing');
    expect(v.issues.some((i) => i.code === 'NO_VERDICT')).toBe(true);
    expect(isAdvanceable(v)).toBe(false);
  });

  it('does not advance on PARTIAL/FAIL', () => {
    expect(isAdvanceable(validateProof(ALL, 'Verdict: PARTIAL'))).toBe(false);
    expect(isAdvanceable(validateProof(ALL, 'Verdict: FAIL'))).toBe(false);
  });
});
