import { describe, it, expect } from 'vitest';
import { RbacLayer, rbacLayer, actionMatches, RBAC_REASON_CODES } from '../rbac';
import { PolicyEngine } from '../decision';
import { humanPrincipal, credentialPrincipal } from '@/agent/identity/principals';
import type { PolicyEvaluationInput } from '../decision';

const identity = {
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
};

const input = (roles: string[], action: string): PolicyEvaluationInput => ({
  identity,
  principal: humanPrincipal(identity, roles),
  action,
  resource: { type: 'order', tenantId: 'alma' },
});

describe('actionMatches (SPEC-106)', () => {
  it('matches exact actions', () => {
    expect(actionMatches('orders.read', 'orders.read')).toBe(true);
    expect(actionMatches('orders.read', 'orders.write')).toBe(false);
  });
  it('matches namespace wildcard but not across segments or bare namespace', () => {
    expect(actionMatches('orders.*', 'orders.read')).toBe(true);
    expect(actionMatches('orders.*', 'orders.x.y')).toBe(true);
    expect(actionMatches('orders.*', 'orders')).toBe(false);
    expect(actionMatches('orders.*', 'ordersX.read')).toBe(false);
  });
  it('bare star matches everything', () => {
    expect(actionMatches('*', 'anything.at.all')).toBe(true);
  });
});

describe('RbacLayer.evaluate (SPEC-106)', () => {
  const layer = rbacLayer([
    { role: 'owner', allow: ['*'] },
    { role: 'staff', allow: ['orders.read', 'orders.write'], deny: ['orders.delete'] },
    { role: 'viewer', allow: ['orders.read'] },
  ]);

  it('permits when a role grants the action', () => {
    const v = layer.evaluate(input(['viewer'], 'orders.read'));
    expect(v.effect).toBe('permit');
    expect(v.reasonCodes).toContain(RBAC_REASON_CODES.ROLE_GRANTED);
  });

  it('abstains (not deny) when no role grants the action', () => {
    const v = layer.evaluate(input(['viewer'], 'orders.write'));
    expect(v.effect).toBe('abstain');
    expect(v.reasonCodes).toContain(RBAC_REASON_CODES.NO_ROLE_GRANT);
  });

  it('owner wildcard permits any action', () => {
    expect(layer.evaluate(input(['owner'], 'wallet.debit')).effect).toBe('permit');
  });

  it('explicit role deny overrides that role grants', () => {
    const v = layer.evaluate(input(['staff'], 'orders.delete'));
    expect(v.effect).toBe('deny');
    expect(v.reasonCodes).toContain(RBAC_REASON_CODES.ROLE_EXPLICIT_DENY);
  });

  it('unknown role abstains (fail-closed, no implicit grant)', () => {
    expect(layer.evaluate(input(['ghost'], 'orders.read')).effect).toBe('abstain');
  });

  it('no roles at all abstains', () => {
    expect(layer.evaluate(input([], 'orders.read')).effect).toBe('abstain');
  });

  it('uses credential scopes as roles', () => {
    const l = rbacLayer([{ role: 'orders:read', allow: ['orders.read'] }]);
    const v = l.evaluate({
      identity,
      principal: credentialPrincipal('alma', 'svc-1', ['orders:read']),
      action: 'orders.read',
      resource: { type: 'order' },
    });
    expect(v.effect).toBe('permit');
  });

  it('rejects an invalid binding at construction (fail-closed)', () => {
    expect(() => new RbacLayer([{ role: '', allow: [] }])).toThrow();
  });
});

describe('RBAC through the engine (SPEC-105 + SPEC-106)', () => {
  const engine = new PolicyEngine([
    rbacLayer([{ role: 'staff', allow: ['orders.read'], deny: ['orders.delete'] }]),
  ]);

  it('ALLOWS a granted action end-to-end', () => {
    const r = engine.decide(input(['staff'], 'orders.read'));
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') expect(r.value.permittedBy).toEqual(['rbac']);
  });

  it('DENIES an ungranted action via fail-closed default', () => {
    const r = engine.decide(input(['staff'], 'orders.write'));
    expect(r.status).toBe('DENIED');
  });

  it('DENIES an explicitly denied action (deny-overrides)', () => {
    const r = engine.decide(input(['staff'], 'orders.delete'));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RBAC_REASON_CODES.ROLE_EXPLICIT_DENY);
  });

  it('DENIES cross-tenant even when the role would grant', () => {
    const foreign = {
      ...input(['staff'], 'orders.read'),
      principal: humanPrincipal({ ...identity, tenantId: 'other' }, ['staff']),
    };
    expect(engine.decide(foreign).status).toBe('DENIED');
  });
});
