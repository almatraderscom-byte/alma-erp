import { describe, it, expect } from 'vitest';
import { gateUserResponse, RESPONSE_GATE_REASON_CODES, type ResponseGateInput } from '../response-gate';

const known = new Set(['ev-1']);
const ok: ResponseGateInput = {
  responseText: 'Boss, apnar post ta live hoyeche.',
  claims: [{ id: 'c1', text: 'post live', evidenceRefs: ['ev-1'] }],
  knownEvidenceIds: known,
  postconditions: [{ post: { id: 'pub', checks: [{ path: 'status', op: 'eq', value: 'published' }] }, observed: { status: 'published' } }],
};

describe('gateUserResponse (SPEC-183)', () => {
  it('ALLOWS a clean, verified, evidence-backed response', () => {
    const r = gateUserResponse(ok);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') expect(r.value.text).toContain('Boss');
  });
  it('DENIES when a postcondition fails', () => {
    const r = gateUserResponse({ ...ok, postconditions: [{ post: { id: 'pub', checks: [{ path: 'status', op: 'eq', value: 'live' }] }, observed: { status: 'draft' } }] });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes.join()).toContain(RESPONSE_GATE_REASON_CODES.POSTCONDITION_FAILED);
  });
  it('DENIES an unbacked claim', () => {
    const r = gateUserResponse({ ...ok, claims: [{ id: 'c2', text: 'x', evidenceRefs: [] }] });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RESPONSE_GATE_REASON_CODES.UNBACKED_CLAIM);
  });
  it('DENIES a secret leak', () => {
    const r = gateUserResponse({ ...ok, responseText: 'key is sk-ABCD1234EFGH' });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RESPONSE_GATE_REASON_CODES.SECRET_LEAK);
  });
  it('DENIES a banned form of address (Sir / স্যার)', () => {
    expect(gateUserResponse({ ...ok, responseText: 'Sir, done.' }).status).toBe('DENIED');
    expect(gateUserResponse({ ...ok, responseText: 'স্যার, done.' }).status).toBe('DENIED');
  });
});
