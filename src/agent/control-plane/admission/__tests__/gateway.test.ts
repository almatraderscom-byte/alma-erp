import { describe, it, expect } from 'vitest';
import { COMPONENT_CONTRACT_VERSION, REASON_CODES } from '@/agent/contracts';
import { admit, type AdmissionStage } from '../gateway';
import { ADMISSION_STAGES } from '../registry';

function req(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      tenantId: 'alma',
      actorId: 'maruf',
      workflowId: 'wf-1',
      stepId: 'admission',
      correlationId: 'corr-1',
    },
    contractVersion: COMPONENT_CONTRACT_VERSION,
    payload: { channel: 'telegram', text: 'hi' },
    ...overrides,
  };
}

describe('admit — the single door', () => {
  it('admits a valid request with no stages', () => {
    const r = admit(req(), []);
    expect(r.status).toBe('COMPLETED');
    if (r.status === 'COMPLETED') {
      expect(r.value.admitted).toBe(true);
      expect(r.value.identity.tenantId).toBe('alma');
      expect(r.value.stagesRun).toEqual([]);
    }
  });

  it('fails closed when identity is missing', () => {
    const r = admit(req({ identity: { actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' } }), []);
    expect(r.status).not.toBe('COMPLETED');
    if ('reasonCodes' in r) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT);
  });

  it('rejects a malformed payload (missing channel)', () => {
    const r = admit(req({ payload: { text: 'x' } }), []);
    expect(r.status).not.toBe('COMPLETED');
  });

  it('runs stages in order and records which ran', () => {
    const calls: string[] = [];
    const stage = (id: string): AdmissionStage => ({
      id,
      run(ctx) {
        calls.push(id);
        return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, [id]: true } } };
      },
    });
    const r = admit(req(), [stage('a'), stage('b')]);
    expect(calls).toEqual(['a', 'b']);
    if (r.status === 'COMPLETED') {
      expect(r.value.stagesRun).toEqual(['a', 'b']);
      expect(r.value.annotations).toMatchObject({ a: true, b: true });
    }
  });

  it('short-circuits on the first stage failure', () => {
    const after: string[] = [];
    const failing: AdmissionStage = {
      id: 'reject',
      run() {
        return { ok: false, failure: { status: 'DENIED', reasonCodes: [REASON_CODES.POLICY_DENIED], evidenceIds: [] } };
      },
    };
    const never: AdmissionStage = { id: 'never', run(ctx) { after.push('never'); return { ok: true, ctx }; } };
    const r = admit(req(), [failing, never]);
    expect(r.status).toBe('DENIED');
    expect(after).toEqual([]); // downstream stage never ran
  });

  it('exposes a well-formed default registry (stages are appended as specs land)', () => {
    // The registry grows as G02 specs register stages; every entry must be a
    // valid AdmissionStage. (Do NOT assert emptiness — that regresses each time
    // a stage is added; SPEC-011 originally asserted [] which broke at SPEC-012.)
    expect(Array.isArray(ADMISSION_STAGES)).toBe(true);
    for (const s of ADMISSION_STAGES) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.run).toBe('function');
    }
  });
});
