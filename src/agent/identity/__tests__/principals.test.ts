import { describe, it, expect } from 'vitest';
import { humanPrincipal, humanPrincipalSchema } from '../principals';

const id = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

describe('humanPrincipal (SPEC-101)', () => {
  it('builds a human principal from an execution identity', () => {
    const p = humanPrincipal(id, ['owner']);
    expect(p.kind).toBe('human');
    expect(p.tenantId).toBe('alma');
    expect(p.actorId).toBe('maruf');
    expect(p.roles).toEqual(['owner']);
  });
  it('defaults to no roles', () => {
    expect(humanPrincipal(id).roles).toEqual([]);
  });
  it('carries the tenant for isolation', () => {
    expect(humanPrincipal({ ...id, tenantId: 'other' }).tenantId).toBe('other');
  });
  it('rejects an invalid principal (fail-closed)', () => {
    expect(humanPrincipalSchema.safeParse({ kind: 'human', tenantId: '', actorId: 'x', roles: [] }).success).toBe(false);
  });
  it('copies roles (no external mutation)', () => {
    const roles = ['owner']; const p = humanPrincipal(id, roles); roles.push('admin');
    expect(p.roles).toEqual(['owner']);
  });
});
