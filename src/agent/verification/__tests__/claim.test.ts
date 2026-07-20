import { describe, it, expect } from 'vitest';
import { verifyClaims, findUnbackedClaims, CLAIM_REASON_CODES, type Claim } from '../claim';

const known = new Set(['ev-1', 'ev-2']);
const backed: Claim = { id: 'c1', text: 'posted', evidenceRefs: ['ev-1'] };
const uncited: Claim = { id: 'c2', text: 'guessed', evidenceRefs: [] };
const bogus: Claim = { id: 'c3', text: 'fabricated', evidenceRefs: ['ev-999'] };

describe('findUnbackedClaims (SPEC-182)', () => {
  it('flags uncited and bogus-evidence claims', () => {
    expect(findUnbackedClaims([backed, uncited, bogus], known).sort()).toEqual(['c2', 'c3']);
  });
  it('all-backed yields none', () => {
    expect(findUnbackedClaims([backed], known)).toEqual([]);
  });
});

describe('verifyClaims (SPEC-182)', () => {
  it('COMPLETED when every claim is backed', () => {
    expect(verifyClaims([backed], known).status).toBe('COMPLETED');
  });
  it('FAILED_FINAL listing unbacked claims (fail-closed)', () => {
    const r = verifyClaims([backed, uncited], known);
    expect(r.status).toBe('FAILED_FINAL');
    if (r.status === 'FAILED_FINAL') {
      expect(r.reasonCodes).toContain(CLAIM_REASON_CODES.UNBACKED);
      expect(r.reasonCodes).toContain('c2');
    }
  });
  it('an uncited claim never counts as verified', () => {
    expect(verifyClaims([uncited], known).status).toBe('FAILED_FINAL');
  });
});
