import { describe, it, expect } from 'vitest';
import { HrApprovalRule, hrApprovalRule, HR_REASON_CODES } from '../hr-rule';
import { AutonomyEngine, type AutonomyInput } from '../../autonomy/states';
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const allow = (action: string): PolicyDecision =>
  decidePolicy({ identity, principal: humanPrincipal(identity, ['owner']), action, resource: { type: 'staff', id: 's1', tenantId: 'alma' } }, [rbacLayer([{ role: 'owner', allow: ['*'] }])]);
const input = (action: string, resourceType: string, attributes?: Record<string, unknown>): AutonomyInput => ({
  identity, action: { action, resourceType, resourceId: 's1', attributes }, policyDecision: allow(action),
});

describe('HrApprovalRule (SPEC-115)', () => {
  const rule = hrApprovalRule({ routineActions: ['staff.notify'] });
  it('abstains on non-HR actions', () => {
    expect(rule.evaluate(input('orders.read', 'order')).effect).toBe('abstain');
  });
  it('fire/hire/salary ALWAYS need approval', () => {
    expect(rule.evaluate(input('fire.execute', 'staff')).reasonCodes).toContain(HR_REASON_CODES.ALWAYS_APPROVE);
    expect(rule.evaluate(input('salary.set', 'staff')).effect).toBe('require_approval');
    expect(rule.evaluate(input('staff.role', 'staff')).effect).toBe('require_approval');
  });
  it('an allowlisted routine staff action is autonomous', () => {
    const v = rule.evaluate(input('staff.notify', 'staff'));
    expect(v.effect).toBe('autonomous_ok');
    expect(v.reasonCodes).toContain(HR_REASON_CODES.ROUTINE_OK);
  });
  it('any other HR action needs approval (fail-closed)', () => {
    expect(rule.evaluate(input('staff.message', 'staff')).reasonCodes).toContain(HR_REASON_CODES.UNCLASSIFIED_HR);
  });
  it('detects HR by resource type', () => {
    expect(rule.evaluate(input('x.do', 'employee')).effect).toBe('require_approval');
  });
  it('throws on invalid config', () => {
    expect(() => new HrApprovalRule({ routineActions: [''] })).toThrow();
  });
});

describe('HR through the autonomy engine (SPEC-111 + SPEC-115)', () => {
  const engine = new AutonomyEngine([hrApprovalRule()]);
  it('fire → NEEDS_APPROVAL', () => {
    expect(engine.decide(input('fire.execute', 'staff')).status).toBe('NEEDS_APPROVAL');
  });
  it('unclassified staff action → NEEDS_APPROVAL', () => {
    expect(engine.decide(input('staff.message', 'staff')).status).toBe('NEEDS_APPROVAL');
  });
});
