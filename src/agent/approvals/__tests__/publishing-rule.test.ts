import { describe, it, expect } from 'vitest';
import { PublishingApprovalRule, publishingApprovalRule, PUBLISHING_REASON_CODES } from '../publishing-rule';
import { AutonomyEngine, type AutonomyInput } from '../../autonomy/states';
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const allow = (action: string): PolicyDecision =>
  decidePolicy({ identity, principal: humanPrincipal(identity, ['staff']), action, resource: { type: 'post', id: 'p', tenantId: 'alma' } }, [rbacLayer([{ role: 'staff', allow: ['*'] }])]);
const input = (action: string, resourceType: string, attributes?: Record<string, unknown>): AutonomyInput => ({
  identity, action: { action, resourceType, resourceId: 'p', attributes }, policyDecision: allow(action),
});
const rule = publishingApprovalRule();

describe('PublishingApprovalRule (SPEC-114)', () => {
  it('abstains on non-publishing actions', () => {
    expect(rule.evaluate(input('orders.read', 'order')).effect).toBe('abstain');
  });
  it('require_approval for a public audience', () => {
    const v = rule.evaluate(input('facebook.publish', 'post', { audience: 'public' }));
    expect(v.effect).toBe('require_approval');
    expect(v.reasonCodes).toContain(PUBLISHING_REASON_CODES.EXTERNAL_AUDIENCE);
  });
  it('autonomous_ok for an internal draft', () => {
    expect(rule.evaluate(input('post.create', 'post', { audience: 'draft' })).effect).toBe('autonomous_ok');
  });
  it('require_approval when audience is unknown (fail-closed)', () => {
    expect(rule.evaluate(input('facebook.publish', 'post')).reasonCodes).toContain(PUBLISHING_REASON_CODES.AUDIENCE_UNKNOWN);
    expect(rule.evaluate(input('facebook.publish', 'post', { audience: 42 })).effect).toBe('require_approval');
  });
  it('detects publishing by resource type too', () => {
    expect(rule.evaluate(input('x.send', 'message', { audience: 'customer' })).effect).toBe('require_approval');
  });
  it('throws on invalid config', () => {
    expect(() => new PublishingApprovalRule({ externalAudiences: [''] })).toThrow();
  });
});

describe('publishing through the autonomy engine (SPEC-111 + SPEC-114)', () => {
  const engine = new AutonomyEngine([rule]);
  it('public post → NEEDS_APPROVAL', () => {
    expect(engine.decide(input('facebook.publish', 'post', { audience: 'public' })).status).toBe('NEEDS_APPROVAL');
  });
  it('draft → AUTONOMOUS', () => {
    expect(engine.decide(input('post.create', 'post', { audience: 'draft' })).status).toBe('ALLOWED');
  });
});
