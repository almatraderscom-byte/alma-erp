import { describe, it, expect } from 'vitest';
import { RelationshipLayer, relationshipLayer, principalRef, REL_REASON_CODES, type RelationTuple, type RelationRequirement } from '../relationship';
import { PolicyEngine, type PolicyEvaluationInput } from '../decision';
import { rbacLayer } from '../rbac';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

const input = (over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput => ({
  identity,
  principal: humanPrincipal(identity, ['staff']),
  action: 'orders.read',
  resource: { type: 'order', id: 'o-1', tenantId: 'alma' },
  ...over,
});

const tuples: RelationTuple[] = [
  { subject: 'human:maruf', relation: 'owner', object: 'order:o-1' },
  { subject: 'human:staff1', relation: 'member', object: 'team:sales' },
  { subject: 'team:sales', relation: 'manager', object: 'order:o-1' },
  { subject: 'human:blocked', relation: 'blocked', object: 'order:o-1' },
];
const reqs: RelationRequirement[] = [
  { resourceType: 'order', permitRelations: ['owner', 'manager'], denyRelations: ['blocked'] },
];

describe('principalRef (SPEC-108)', () => {
  it('derives a tenant-free type:id subject ref', () => {
    expect(principalRef(humanPrincipal(identity))).toBe('human:maruf');
    expect(principalRef(agentPrincipal({ ...identity, agentId: 'alma-bot' }))).toBe('agent:alma-bot');
  });
});

describe('RelationshipLayer.evaluate (SPEC-108)', () => {
  const layer = relationshipLayer(tuples, reqs);

  it('permits a direct owner relation', () => {
    const v = layer.evaluate(input());
    expect(v.effect).toBe('permit');
    expect(v.reasonCodes).toContain('rel:owner');
  });

  it('permits via one group hop (member→team, team→manager→object)', () => {
    const v = layer.evaluate(input({ principal: humanPrincipal({ ...identity, actorId: 'staff1' }, ['staff']) }));
    expect(v.effect).toBe('permit');
    expect(v.reasonCodes).toContain('rel:manager');
  });

  it('abstains when the principal has no relation', () => {
    const v = layer.evaluate(input({ principal: humanPrincipal({ ...identity, actorId: 'stranger' }) }));
    expect(v.effect).toBe('abstain');
    expect(v.reasonCodes).toContain(REL_REASON_CODES.NO_RELATION);
  });

  it('denies when a deny relation is held (veto)', () => {
    const v = layer.evaluate(input({ principal: humanPrincipal({ ...identity, actorId: 'blocked' }) }));
    expect(v.effect).toBe('deny');
    expect(v.reasonCodes).toContain(REL_REASON_CODES.RELATION_DENY);
  });

  it('abstains when the resource has no id (instance-scoped, fail-closed)', () => {
    const v = layer.evaluate(input({ resource: { type: 'order', tenantId: 'alma' } }));
    expect(v.effect).toBe('abstain');
    expect(v.reasonCodes).toContain(REL_REASON_CODES.NO_RESOURCE_ID);
  });

  it('abstains for an unmanaged resource type', () => {
    expect(layer.evaluate(input({ resource: { type: 'wallet', id: 'w-1' } })).effect).toBe('abstain');
  });

  it('respects maxGroupHops=0 (no indirection)', () => {
    const noHop = relationshipLayer(tuples, reqs, { maxGroupHops: 0 });
    const v = noHop.evaluate(input({ principal: humanPrincipal({ ...identity, actorId: 'staff1' }) }));
    expect(v.effect).toBe('abstain'); // manager only reachable via the group hop
  });

  it('throws on an invalid tuple or requirement', () => {
    expect(() => new RelationshipLayer([{ subject: '', relation: 'x', object: 'y' }], reqs)).toThrow();
    expect(() => new RelationshipLayer(tuples, [{ resourceType: 'order', permitRelations: [] }])).toThrow();
  });

  it('relationsBetween exposes direct + hop relations', () => {
    expect([...layer.relationsBetween('human:maruf', 'order:o-1')]).toContain('owner');
    expect([...layer.relationsBetween('human:staff1', 'order:o-1')]).toContain('manager');
  });
});

describe('Relationship through the engine (SPEC-105/106/108)', () => {
  it('RBAC abstains but relationship permits → ALLOW', () => {
    const engine = new PolicyEngine([
      rbacLayer([]), // no role grants
      relationshipLayer(tuples, reqs),
    ]);
    const r = engine.decide(input()); // maruf owns o-1
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') expect(r.value.permittedBy).toEqual(['relationship']);
  });

  it('relationship deny-relation vetoes even an RBAC permit', () => {
    const engine = new PolicyEngine([
      rbacLayer([{ role: 'staff', allow: ['orders.read'] }]),
      relationshipLayer(tuples, reqs),
    ]);
    const r = engine.decide(input({ principal: humanPrincipal({ ...identity, actorId: 'blocked' }, ['staff']) }));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(REL_REASON_CODES.RELATION_DENY);
  });
});
