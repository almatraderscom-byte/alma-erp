import { describe, it, expect } from 'vitest';
import {
  certifyArchitecture,
  certificationDigest,
  certificationPayloadSchema,
  CERT_REASON_CODES,
  REQUIRED_GATE_STEPS,
  type CertificationPayload,
} from '../certification';
import { COMPONENT_CONTRACT_VERSION, type ComponentRequest, type ExecutionIdentity } from '@/agent/contracts';

const identity: ExecutionIdentity = {
  tenantId: 'alma',
  actorId: 'owner',
  workflowId: 'wf-cert',
  stepId: 'certify',
  correlationId: 'corr-1',
};

function goodPayload(overrides: Partial<CertificationPayload> = {}): CertificationPayload {
  const expectedSpecCount = 5;
  return {
    expectedSpecCount,
    auditedCommit: '8fe4410c76f6601efdf86fee10fb6fbf16409e9e',
    gateSteps: REQUIRED_GATE_STEPS.map((id) => ({ id, verdict: 'PASS' as const })),
    specProofs: Array.from({ length: expectedSpecCount }, (_, i) => ({
      spec: `SPEC-${String(i + 1).padStart(3, '0')}`,
      verdict: 'PASS' as const,
      missing: [],
    })),
    checklist: [
      { id: 'freeze-gate', description: 'Architecture Freeze Gate passes from a clean checkout', satisfied: true, evidenceRef: 'gate:proof-complete' },
    ],
    ...overrides,
  };
}

function request(payload: CertificationPayload, contractVersion: string = COMPONENT_CONTRACT_VERSION): ComponentRequest<CertificationPayload> {
  return { identity, contractVersion, payload };
}

describe('final architecture certification (SPEC-200)', () => {
  it('certifies complete PASS evidence and stamps a deterministic digest', () => {
    const p = goodPayload();
    const r = certifyArchitecture(request(p));
    expect(r.status).toBe('COMPLETED');
    if (r.status !== 'COMPLETED') return;
    expect(r.value.certified).toBe(true);
    expect(r.value.specCount).toBe(5);
    expect(r.value.digest).toBe(certificationDigest(p));
    expect(r.evidenceIds).toContain('gate:proof-complete');
    expect(r.evidenceIds).toContain('specs:5');
  });

  it('is deterministic: same evidence ⇒ same digest; changed evidence ⇒ new digest', () => {
    const a = certificationDigest(goodPayload());
    const b = certificationDigest(goodPayload());
    const c = certificationDigest(goodPayload({ auditedCommit: 'deadbeef' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('denies when identity is missing (fail closed)', () => {
    const r = certifyArchitecture({ identity: {} as ExecutionIdentity, contractVersion: COMPONENT_CONTRACT_VERSION, payload: goodPayload() });
    expect(r.status).toBe('DENIED');
  });

  it('fails final on contract version mismatch', () => {
    const r = certifyArchitecture(request(goodPayload(), '0.0.1'));
    expect(r.status).toBe('FAILED_FINAL');
  });

  it('fails final on malformed payload', () => {
    const bad = { ...goodPayload(), auditedCommit: 'NOT-A-SHA' } as CertificationPayload;
    const r = certifyArchitecture(request(bad));
    expect(r.status).toBe('FAILED_FINAL');
  });

  it('rejects oversized evidence (bounded input)', () => {
    const bad = goodPayload({ specProofs: Array.from({ length: 1001 }, (_, i) => ({ spec: 'SPEC-001', verdict: 'PASS' as const, missing: [] })) });
    expect(certificationPayloadSchema.safeParse(bad).success).toBe(false);
    expect(certifyArchitecture(request(bad)).status).toBe('FAILED_FINAL');
  });

  it('denies when a required gate step is absent', () => {
    const p = goodPayload({ gateSteps: goodPayload().gateSteps.filter((g) => g.id !== 'proof-complete') });
    const r = certifyArchitecture(request(p));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(CERT_REASON_CODES.GATE_STEP_MISSING);
  });

  it('denies when a required gate step failed', () => {
    const p = goodPayload({ gateSteps: goodPayload().gateSteps.map((g) => (g.id === 'forbidden-imports' ? { ...g, verdict: 'FAIL' as const } : g)) });
    const r = certifyArchitecture(request(p));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(CERT_REASON_CODES.GATE_STEP_FAILED);
  });

  it('denies when a spec id is missing from the set (deleted proof dir)', () => {
    const p = goodPayload({ specProofs: goodPayload().specProofs.slice(1) });
    const r = certifyArchitecture(request(p));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(CERT_REASON_CODES.SPEC_SET_INCOMPLETE);
  });

  it('denies when a spec verdict is PARTIAL or artifacts are missing', () => {
    const proofs = goodPayload().specProofs;
    proofs[2] = { ...proofs[2], verdict: 'PARTIAL', missing: ['test-results.md'] };
    const r = certifyArchitecture(request(goodPayload({ specProofs: proofs })));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') {
      expect(r.reasonCodes).toContain(CERT_REASON_CODES.SPEC_VERDICT_NOT_PASS);
      expect(r.reasonCodes).toContain(CERT_REASON_CODES.SPEC_PROOF_MISSING);
    }
  });

  it('denies an unsatisfied or evidence-free checklist item', () => {
    const r1 = certifyArchitecture(request(goodPayload({ checklist: [{ id: 'x', description: 'd', satisfied: false, evidenceRef: 'e' }] })));
    expect(r1.status).toBe('DENIED');
    if (r1.status === 'DENIED') expect(r1.reasonCodes).toContain(CERT_REASON_CODES.CHECKLIST_UNSATISFIED);

    const r2 = certifyArchitecture(request(goodPayload({ checklist: [{ id: 'x', description: 'd', satisfied: true, evidenceRef: '  ' }] })));
    expect(r2.status).toBe('DENIED');
    if (r2.status === 'DENIED') expect(r2.reasonCodes).toContain(CERT_REASON_CODES.CHECKLIST_NO_EVIDENCE);
  });

  it('never throws on hostile input', () => {
    expect(() => certifyArchitecture(undefined as unknown as ComponentRequest<CertificationPayload>)).not.toThrow();
    expect(() => certifyArchitecture({ identity, contractVersion: COMPONENT_CONTRACT_VERSION, payload: null as unknown as CertificationPayload })).not.toThrow();
  });
});
