import { describe, it, expect } from 'vitest';
import {
  AutonomyEngine, decideAutonomy, autonomyStateOf, AUTONOMY_REASON_CODES,
  type AutonomyInput, type ApprovalRule,
} from '../states';
import { PolicyEngine, decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

// A policy ALLOW / DENY for the same action, via the real G11 engine.
const policyAllow: PolicyDecision = decidePolicy(
  { identity, principal: humanPrincipal(identity, ['staff']), action: 'wallet.debit', resource: { type: 'wallet', id: 'w-1', tenantId: 'alma' } },
  [rbacLayer([{ role: 'staff', allow: ['wallet.debit'] }])],
);
const policyDeny: PolicyDecision = decidePolicy(
  { identity, principal: humanPrincipal(identity, ['staff']), action: 'wallet.debit', resource: { type: 'wallet', id: 'w-1', tenantId: 'alma' } },
  [rbacLayer([])], // no grant → fail-closed DENY
);

const input = (policyDecision: PolicyDecision, attrs: Record<string, unknown> = {}): AutonomyInput => ({
  identity,
  action: { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w-1', attributes: attrs },
  policyDecision,
});

const routineRule = (name: string): ApprovalRule => ({ name, evaluate: () => ({ rule: name, effect: 'autonomous_ok', reasonCodes: [] }) });
const approvalRule = (name: string, codes: string[] = []): ApprovalRule => ({ name, evaluate: () => ({ rule: name, effect: 'require_approval', reasonCodes: codes }) });
const abstainRule = (name: string): ApprovalRule => ({ name, evaluate: () => ({ rule: name, effect: 'abstain', reasonCodes: [] }) });

describe('AutonomyEngine.decide — fail-closed autonomy (SPEC-111)', () => {
  it('DENIES when policy did not allow (autonomy never overrides a policy deny)', () => {
    const r = new AutonomyEngine([routineRule('r')]).decide(input(policyDeny));
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') {
      expect(r.reasonCodes).toContain(AUTONOMY_REASON_CODES.POLICY_DENIED);
      // carries the underlying policy reason(s) through
      expect(r.reasonCodes.length).toBeGreaterThan(1);
    }
  });

  it('NEEDS_APPROVAL when no rule classifies the action (unclassified ⇒ ask)', () => {
    const r = decideAutonomy(input(policyAllow), []);
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') expect(r.reasonCodes).toContain(AUTONOMY_REASON_CODES.UNCLASSIFIED_REQUIRES_APPROVAL);
  });

  it('NEEDS_APPROVAL when all rules abstain', () => {
    const r = decideAutonomy(input(policyAllow), [abstainRule('a'), abstainRule('b')]);
    expect(r.status).toBe('NEEDS_APPROVAL');
  });

  it('AUTONOMOUS only when a rule says routine and none require approval', () => {
    const r = decideAutonomy(input(policyAllow), [routineRule('low-value'), abstainRule('x')]);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') {
      expect(r.value.state).toBe('AUTONOMOUS');
      expect(r.value.routineBy).toEqual(['low-value']);
    }
  });

  it('require-approval OVERRIDES routine (a single flag forces a prompt)', () => {
    const r = decideAutonomy(input(policyAllow), [routineRule('low-value'), approvalRule('big-money', ['OVER_CAP'])]);
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') {
      expect(r.reasonCodes).toContain(AUTONOMY_REASON_CODES.APPROVAL_REQUIRED);
      expect(r.reasonCodes).toContain('OVER_CAP');
    }
  });

  it('malformed action falls to the SAFE side (NEEDS_APPROVAL, never AUTONOMOUS)', () => {
    const bad = { ...input(policyAllow), action: { action: '', resourceType: '' } };
    const r = new AutonomyEngine([routineRule('r')]).decide(bad as AutonomyInput);
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') expect(r.reasonCodes).toContain(AUTONOMY_REASON_CODES.MALFORMED_REQUEST);
  });

  it('does not throw on garbage input', () => {
    expect(() => decideAutonomy({} as AutonomyInput, [])).not.toThrow();
  });
});

describe('AutonomyEngine — introspection & determinism', () => {
  it('exposes rule names in order and is immutable to caller array mutation', () => {
    const rules = [routineRule('r1')];
    const e = new AutonomyEngine(rules);
    rules.push(approvalRule('injected'));
    expect(e.ruleNames()).toEqual(['r1']);
    expect(e.decide(input(policyAllow)).status).toBe('ALLOWED'); // injected must not leak
  });

  it('autonomyStateOf maps each terminal state', () => {
    expect(autonomyStateOf(decideAutonomy(input(policyAllow), [routineRule('r')]))).toBe('AUTONOMOUS');
    expect(autonomyStateOf(decideAutonomy(input(policyAllow), []))).toBe('NEEDS_APPROVAL');
    expect(autonomyStateOf(decideAutonomy(input(policyDeny), []))).toBe('DENIED');
  });

  it('is deterministic — same input, same decision', () => {
    const e = new AutonomyEngine([routineRule('r')]);
    expect(e.decide(input(policyAllow))).toEqual(e.decide(input(policyAllow)));
  });
});
