import { describe, it, expect } from 'vitest';
import { separationViolations, isEligibleApprover, resolveApprovalWithSod, SOD_REASON_CODES } from '../separation';
import { newApprovalRequest, type ApprovalDecisionInput } from '../contract';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';
import type { ActionDescriptor } from '../../autonomy/states';

const identity = { tenantId: 'alma', actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const action: ActionDescriptor = { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w-1', attributes: { amountNano: 5000 } };
const T0 = 1_000_000, TTL = 60_000;
const req = () => newApprovalRequest('appr-1', identity, action, ['X'], T0, TTL);
const cfg = { requiredApproverRoles: ['approver', 'owner'] };

const boss = humanPrincipal({ ...identity, actorId: 'maruf' }, ['owner']);

describe('separationViolations (SPEC-117)', () => {
  it('eligible: distinct human with an approver role', () => {
    expect(separationViolations(req(), boss, cfg)).toEqual([]);
    expect(isEligibleApprover(req(), boss, cfg)).toBe(true);
  });
  it('rejects an approver without a required role', () => {
    const peer = humanPrincipal({ ...identity, actorId: 'staff-2' }, ['staff']);
    expect(separationViolations(req(), peer, cfg)).toContain(SOD_REASON_CODES.MISSING_APPROVER_ROLE);
  });
  it('rejects a non-human approver', () => {
    const bot = agentPrincipal({ ...identity, actorId: 'agent-9', agentId: 'agent-9' }, ['owner']);
    expect(separationViolations(req(), bot, cfg)).toContain(SOD_REASON_CODES.NOT_HUMAN);
  });
  it('rejects the requesting actor/agent even with an owner role', () => {
    const self = humanPrincipal({ ...identity, actorId: 'agent-1' }, ['owner']);
    const v = separationViolations(req(), self, cfg);
    expect(v).toContain(SOD_REASON_CODES.APPROVER_IS_REQUESTER);
    expect(v).toContain(SOD_REASON_CODES.APPROVER_IS_REQUESTING_AGENT);
  });
  it('rejects a cross-tenant approver', () => {
    const foreign = humanPrincipal({ ...identity, tenantId: 'other', actorId: 'x' }, ['owner']);
    expect(separationViolations(req(), foreign, cfg)).toContain(SOD_REASON_CODES.CROSS_TENANT);
  });
  it('a misconfigured policy is fail-closed (ineligible)', () => {
    expect(separationViolations(req(), boss, { requiredApproverRoles: [] }).length).toBeGreaterThan(0);
  });
});

describe('resolveApprovalWithSod (SPEC-112 + SPEC-117)', () => {
  const grant = (approver = boss): ApprovalDecisionInput => ({ approvalRequestId: 'appr-1', decision: 'grant', approver, decidedAtMs: T0 + 1000 });
  it('APPROVES a valid grant by an eligible approver', () => {
    expect(resolveApprovalWithSod(req(), grant(), T0 + 2000, cfg).status).toBe('ALLOWED');
  });
  it('DENIES an otherwise-valid grant by an ineligible approver (no approver role)', () => {
    const peer = humanPrincipal({ ...identity, actorId: 'staff-2' }, ['staff']);
    const r = resolveApprovalWithSod(req(), grant(peer), T0 + 2000, cfg);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(SOD_REASON_CODES.MISSING_APPROVER_ROLE);
  });
  it('passes a pending/expired base resolution through unchanged', () => {
    expect(resolveApprovalWithSod(req(), null, T0 + 2000, cfg).status).toBe('NEEDS_APPROVAL');
    expect(resolveApprovalWithSod(req(), grant(), T0 + TTL + 1, cfg).status).toBe('DENIED'); // expired
  });
});
