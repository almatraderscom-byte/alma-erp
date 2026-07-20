import { describe, it, expect } from 'vitest';
import { runSpecialist, validateBrief, SPECIALIST_REASON_CODES, MAX_BRIEF_BYTES, type SpecialistBrief, type SpecialistAdapter } from '../runtime';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const brief = (over: Partial<SpecialistBrief> = {}): SpecialistBrief => ({
  identity, role: 'marketing', task: 'write a caption', input: { product: 'abaya' }, ...over,
});
const marketing: SpecialistAdapter = { role: 'marketing', run: (b) => ({ role: 'marketing', summary: 'done', data: { caption: `buy ${(b.input as { product: string }).product}` } }) };

describe('validateBrief (SPEC-171)', () => {
  it('accepts a valid brief', () => {
    expect(validateBrief(brief())).toEqual([]);
  });
  it('rejects missing identity/role/task', () => {
    expect(validateBrief(brief({ identity: { ...identity, tenantId: '' } }))).toContain(SPECIALIST_REASON_CODES.MISSING_IDENTITY);
    expect(validateBrief(brief({ role: '' }))).toContain(SPECIALIST_REASON_CODES.EMPTY_ROLE);
    expect(validateBrief(brief({ task: '' }))).toContain(SPECIALIST_REASON_CODES.EMPTY_TASK);
  });
  it('rejects an oversized brief', () => {
    const big = 'x'.repeat(MAX_BRIEF_BYTES + 10);
    expect(validateBrief(brief({ input: { big } }))).toContain(SPECIALIST_REASON_CODES.OVERSIZED_BRIEF);
  });
});

describe('runSpecialist (SPEC-171)', () => {
  it('COMPLETED with the specialist output on the happy path', () => {
    const r = runSpecialist(marketing, brief());
    expect(r.status).toBe('COMPLETED');
    if (r.status === 'COMPLETED') expect(r.value.data.caption).toBe('buy abaya');
  });
  it('FAILED_FINAL (not a throw) when the adapter errors', () => {
    const boom: SpecialistAdapter = { role: 'marketing', run: () => { throw new Error('model down'); } };
    const r = runSpecialist(boom, brief());
    expect(r.status).toBe('FAILED_FINAL');
    if (r.status === 'FAILED_FINAL') expect(r.reasonCodes).toContain(SPECIALIST_REASON_CODES.ADAPTER_ERROR);
  });
  it('FAILED_FINAL on an invalid brief (never calls the adapter)', () => {
    let called = false;
    const spy: SpecialistAdapter = { role: 'marketing', run: () => { called = true; return { role: 'marketing', summary: '', data: {} }; } };
    const r = runSpecialist(spy, brief({ task: '' }));
    expect(r.status).toBe('FAILED_FINAL');
    expect(called).toBe(false);
  });
  it('rejects a role mismatch between adapter and brief', () => {
    expect(runSpecialist(marketing, brief({ role: 'finance' })).status).toBe('FAILED_FINAL');
  });
  it('is deterministic given the adapter', () => {
    expect(runSpecialist(marketing, brief())).toEqual(runSpecialist(marketing, brief()));
  });
});
