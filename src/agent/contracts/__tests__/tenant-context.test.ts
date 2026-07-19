import { describe, it, expect } from 'vitest';
import { REASON_CODES } from '../component';
import { createExecutionIdentity } from '../execution-identity';
import { guardResourceAccess, idempotencyKey, stampScope, withBusiness } from '../tenant-context';

function id(over: Record<string, string> = {}) {
  const r = createExecutionIdentity({ tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', ...over });
  if (!r.ok) throw new Error('setup');
  return r.identity;
}

describe('guardResourceAccess — tenant isolation', () => {
  it('allows same-tenant access', () => {
    expect(guardResourceAccess(id(), { tenantId: 'alma' }).ok).toBe(true);
  });

  it('rejects cross-tenant access with CROSS_TENANT', () => {
    const r = guardResourceAccess(id(), { tenantId: 'rival' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.CROSS_TENANT);
  });

  it('fails closed on a missing resource tenant', () => {
    const r = guardResourceAccess(id(), { tenantId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.status).toBe('DENIED');
  });

  it('rejects cross-business within the same tenant', () => {
    const r = guardResourceAccess(id({ businessId: 'lifestyle' }), { tenantId: 'alma', businessId: 'trading' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.CROSS_TENANT);
  });

  it('allows matching business', () => {
    expect(guardResourceAccess(id({ businessId: 'lifestyle' }), { tenantId: 'alma', businessId: 'lifestyle' }).ok).toBe(true);
  });
});

describe('withBusiness + stampScope', () => {
  it('narrows to a business and can advance the step', () => {
    const b = withBusiness(id(), 'trading', 'cost');
    expect(b.businessId).toBe('trading');
    expect(b.stepId).toBe('cost');
  });

  it('stamps caller tenant onto a new resource (never widens)', () => {
    const s = stampScope(id({ businessId: 'lifestyle' }));
    expect(s.tenantId).toBe('alma');
    expect(s.businessId).toBe('lifestyle');
  });
});

describe('idempotencyKey', () => {
  it('is deterministic and scoped by tenant+correlation+step+resource', () => {
    const a = idempotencyKey(id(), 'order-1');
    const b = idempotencyKey(id(), 'order-1');
    expect(a).toBe(b);
    expect(a).toContain('alma:');
    expect(idempotencyKey(id(), 'order-2')).not.toBe(a);
  });
});
