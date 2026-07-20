import { describe, it, expect } from 'vitest';
import {
  PolicyEngine,
  decidePolicy,
  POLICY_REASON_CODES,
  type PolicyLayer,
  type PolicyEvaluationInput,
  type LayerVerdict,
} from '../decision';
import { REASON_CODES } from '@/agent/contracts';
import { humanPrincipal, credentialPrincipal } from '@/agent/identity/principals';

const identity = {
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf-1',
  stepId: 's-1',
  correlationId: 'corr-1',
};

const baseInput = (over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput => ({
  identity,
  principal: humanPrincipal(identity, ['owner']),
  action: 'orders.read',
  resource: { type: 'order', id: 'o-1', tenantId: 'alma' },
  ...over,
});

// Test layers
const permitLayer = (name: string, obligations: string[] = []): PolicyLayer => ({
  name,
  evaluate: (): LayerVerdict => ({ layer: name, effect: 'permit', reasonCodes: [], obligations }),
});
const denyLayer = (name: string, reasonCodes: string[]): PolicyLayer => ({
  name,
  evaluate: (): LayerVerdict => ({ layer: name, effect: 'deny', reasonCodes }),
});
const abstainLayer = (name: string): PolicyLayer => ({
  name,
  evaluate: (): LayerVerdict => ({ layer: name, effect: 'abstain', reasonCodes: [] }),
});

describe('PolicyEngine.decide — fail-closed core (SPEC-105)', () => {
  it('DENIES when there are zero layers (fail-closed default)', () => {
    const r = new PolicyEngine().decide(baseInput());
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(POLICY_REASON_CODES.NO_APPLICABLE_PERMIT);
  });

  it('DENIES when every layer abstains (abstain never grants)', () => {
    const r = decidePolicy(baseInput(), [abstainLayer('rbac'), abstainLayer('abac')]);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(POLICY_REASON_CODES.NO_APPLICABLE_PERMIT);
  });

  it('ALLOWS when at least one layer permits and none deny', () => {
    const r = decidePolicy(baseInput(), [permitLayer('rbac'), abstainLayer('abac')]);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') {
      expect(r.value.effect).toBe('ALLOW');
      expect(r.value.permittedBy).toEqual(['rbac']);
      expect(r.value.principalKey).toBe('human:alma:maruf');
    }
  });

  it('deny OVERRIDES permit (deny-overrides combiner)', () => {
    const r = decidePolicy(baseInput(), [permitLayer('rbac'), denyLayer('abac', ['ATTR_BLOCK'])]);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') {
      expect(r.reasonCodes).toContain(POLICY_REASON_CODES.EXPLICIT_DENY);
      expect(r.reasonCodes).toContain('ATTR_BLOCK');
    }
  });

  it('unions obligations from all permitting layers', () => {
    const r = decidePolicy(baseInput(), [
      permitLayer('rbac', ['redact:pii']),
      permitLayer('abac', ['redact:pii', 'log:audit']),
    ]);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') {
      expect(r.value.obligations.sort()).toEqual(['log:audit', 'redact:pii']);
      expect(r.value.permittedBy).toEqual(['rbac', 'abac']);
    }
  });
});

describe('PolicyEngine.decide — tenant isolation (INV-02)', () => {
  it('DENIES cross-tenant principal before any layer runs', () => {
    const foreign = humanPrincipal({ ...identity, tenantId: 'other' }, ['owner']);
    const r = decidePolicy(baseInput({ principal: foreign }), [permitLayer('rbac')]);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') {
      expect(r.reasonCodes).toContain(REASON_CODES.CROSS_TENANT);
      expect(r.reasonCodes).toContain(POLICY_REASON_CODES.PRINCIPAL_TENANT_MISMATCH);
    }
  });

  it('DENIES cross-tenant resource even with a permitting layer', () => {
    const r = decidePolicy(
      baseInput({ resource: { type: 'order', tenantId: 'other' } }),
      [permitLayer('rbac')],
    );
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') {
      expect(r.reasonCodes).toContain(REASON_CODES.CROSS_TENANT);
      expect(r.reasonCodes).toContain(POLICY_REASON_CODES.RESOURCE_TENANT_MISMATCH);
    }
  });

  it('ALLOWS when resource omits tenantId (not instance-scoped)', () => {
    const r = decidePolicy(baseInput({ resource: { type: 'order' } }), [permitLayer('rbac')]);
    expect(r.status).toBe('ALLOWED');
  });

  it('works for a credential principal too', () => {
    const cred = credentialPrincipal('alma', 'svc-1', ['orders:read']);
    const r = decidePolicy(baseInput({ principal: cred }), [permitLayer('rbac')]);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') expect(r.value.principalKey).toBe('credential:alma:svc-1');
  });
});

describe('PolicyEngine.decide — malformed input is DENY, never a throw', () => {
  it('DENIES an empty action', () => {
    const r = new PolicyEngine([permitLayer('rbac')]).decide(baseInput({ action: '' }));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(POLICY_REASON_CODES.MALFORMED_REQUEST);
  });

  it('DENIES a missing resource type', () => {
    const r = decidePolicy(baseInput({ resource: { type: '' } }), [permitLayer('rbac')]);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(POLICY_REASON_CODES.MALFORMED_REQUEST);
  });

  it('DENIES a missing tenant in identity', () => {
    const bad = { ...baseInput(), identity: { ...identity, tenantId: '' } };
    const r = decidePolicy(bad as PolicyEvaluationInput, [permitLayer('rbac')]);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(POLICY_REASON_CODES.MALFORMED_REQUEST);
  });

  it('does not throw on garbage input', () => {
    expect(() => decidePolicy({} as PolicyEvaluationInput, [])).not.toThrow();
    const r = decidePolicy({} as PolicyEvaluationInput, []);
    expect(r.status).toBe('DENIED');
  });
});

describe('PolicyEngine — immutability & introspection', () => {
  it('exposes layer names in order', () => {
    const e = new PolicyEngine([permitLayer('rbac'), abstainLayer('abac')]);
    expect(e.layerNames()).toEqual(['rbac', 'abac']);
  });

  it('is not affected by mutating the caller-supplied layer array after build', () => {
    const layers = [permitLayer('rbac')];
    const e = new PolicyEngine(layers);
    layers.push(denyLayer('injected', ['X']));
    const r = e.decide(baseInput());
    expect(r.status).toBe('ALLOWED'); // injected deny must NOT leak in
  });

  it('is deterministic — same input yields the same decision', () => {
    const e = new PolicyEngine([permitLayer('rbac')]);
    expect(e.decide(baseInput())).toEqual(e.decide(baseInput()));
  });
});
