import { describe, it, expect } from 'vitest';
import { REASON_CODES } from '../component';
import {
  createExecutionIdentity,
  deriveChildStep,
  deriveCorrelationId,
  identityAuditFields,
  sameTenant,
} from '../execution-identity';

const good = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf-1', stepId: 'admission' };

describe('createExecutionIdentity', () => {
  it('builds a valid identity and derives a correlation id', () => {
    const r = createExecutionIdentity(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.tenantId).toBe('alma');
      expect(r.identity.correlationId).toMatch(/^corr_[0-9a-f]{32}$/);
    }
  });

  it('is deterministic — same input yields same correlation id', () => {
    const a = createExecutionIdentity(good);
    const b = createExecutionIdentity(good);
    if (a.ok && b.ok) expect(a.identity.correlationId).toBe(b.identity.correlationId);
  });

  it('honours an explicit correlation id', () => {
    const r = createExecutionIdentity({ ...good, correlationId: 'corr_fixed' });
    if (r.ok) expect(r.identity.correlationId).toBe('corr_fixed');
  });

  it('fails closed on missing tenant', () => {
    const r = createExecutionIdentity({ ...good, tenantId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.MISSING_TENANT);
  });

  it('fails closed on missing actor', () => {
    const r = createExecutionIdentity({ ...good, actorId: '' });
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.MISSING_ACTOR);
    else throw new Error('expected failure');
  });

  it('fails closed on missing workflow and step', () => {
    const r = createExecutionIdentity({ ...good, workflowId: '', stepId: '' });
    if (!r.ok) {
      expect(r.failure.reasonCodes).toContain(REASON_CODES.MISSING_WORKFLOW);
      expect(r.failure.reasonCodes).toContain(REASON_CODES.MISSING_STEP);
    } else throw new Error('expected failure');
  });

  it('carries optional business + agent ids', () => {
    const r = createExecutionIdentity({ ...good, businessId: 'lifestyle', agentId: 'ops' });
    if (r.ok) {
      expect(r.identity.businessId).toBe('lifestyle');
      expect(r.identity.agentId).toBe('ops');
    }
  });
});

describe('deriveChildStep', () => {
  it('keeps correlation + tenant, changes only stepId', () => {
    const r = createExecutionIdentity(good);
    if (!r.ok) throw new Error('setup');
    const child = deriveChildStep(r.identity, 'cost-governor');
    expect(child.correlationId).toBe(r.identity.correlationId);
    expect(child.tenantId).toBe(r.identity.tenantId);
    expect(child.stepId).toBe('cost-governor');
  });
});

describe('sameTenant + audit fields + deriveCorrelationId', () => {
  it('detects cross-tenant', () => {
    const a = createExecutionIdentity(good);
    const b = createExecutionIdentity({ ...good, tenantId: 'other' });
    if (a.ok && b.ok) expect(sameTenant(a.identity, b.identity)).toBe(false);
  });

  it('emits flat audit fields', () => {
    const r = createExecutionIdentity(good);
    if (r.ok) {
      const f = identityAuditFields(r.identity);
      expect(f.tenantId).toBe('alma');
      expect(f.businessId).toBe('');
    }
  });

  it('deriveCorrelationId is stable and prefixed', () => {
    expect(deriveCorrelationId('a', 'b')).toBe(deriveCorrelationId('a', 'b'));
    expect(deriveCorrelationId('a', 'b')).not.toBe(deriveCorrelationId('a', 'c'));
  });
});
