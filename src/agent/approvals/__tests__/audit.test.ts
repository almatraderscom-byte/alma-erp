import { describe, it, expect } from 'vitest';
import { deriveApprovalEvent, approvalAuditEvent, toG01AuditEvent } from '../audit';
import { newApprovalRequest, type ApprovalDecisionInput } from '../contract';
import { revoke, type ApprovalLifecycleState } from '../lifecycle';
import { humanPrincipal } from '@/agent/identity/principals';
import type { ActionDescriptor } from '../../autonomy/states';

const identity = { tenantId: 'alma', actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'corr-9' };
const action: ActionDescriptor = { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w-1', attributes: { amountNano: 5000 } };
const T0 = 1_000_000, TTL = 60_000;
const req = () => newApprovalRequest('appr-1', identity, action, ['X'], T0, TTL);
const boss = humanPrincipal({ ...identity, actorId: 'maruf' }, ['owner']);
const grant: ApprovalDecisionInput = { approvalRequestId: 'appr-1', decision: 'grant', approver: boss, decidedAtMs: T0 + 1000 };
const deny: ApprovalDecisionInput = { ...grant, decision: 'deny' };
const st = (over: Partial<ApprovalLifecycleState> = {}): ApprovalLifecycleState => ({ request: req(), decision: grant, ...over });

describe('deriveApprovalEvent (SPEC-119)', () => {
  it('classifies each lifecycle kind', () => {
    expect(deriveApprovalEvent(st({ decision: null }), T0 + 100).kind).toBe('pending');
    expect(deriveApprovalEvent(st(), T0 + 2000).kind).toBe('granted');
    expect(deriveApprovalEvent(st({ decision: deny }), T0 + 2000).kind).toBe('denied');
    expect(deriveApprovalEvent(st(), T0 + TTL + 1).kind).toBe('expired');
    expect(deriveApprovalEvent(st({ revocation: revoke('appr-1', T0 + 1500, 'k') }), T0 + 2000).kind).toBe('revoked');
    expect(deriveApprovalEvent(st({ consumption: { approvalRequestId: 'appr-1', consumedAtMs: T0 + 1600 } }), T0 + 2000).kind).toBe('consumed');
  });
});

describe('approvalAuditEvent (SPEC-119)', () => {
  it('carries full identity correlation + approver key', () => {
    const e = approvalAuditEvent(st(), T0 + 2000);
    expect(e).toMatchObject({
      approvalRequestId: 'appr-1', tenantId: 'alma', actorId: 'agent-1',
      workflowId: 'wf', correlationId: 'corr-9', kind: 'granted', action: 'wallet.debit',
      approverKey: 'human:alma:maruf', observedAtMs: T0 + 2000,
    });
  });
  it('omits approverKey when there is no decision', () => {
    expect(approvalAuditEvent(st({ decision: null }), T0 + 100).approverKey).toBeUndefined();
  });
  it('is deterministic (observedAtMs injected)', () => {
    expect(approvalAuditEvent(st(), T0 + 2000)).toEqual(approvalAuditEvent(st(), T0 + 2000));
  });
});

describe('toG01AuditEvent (SPEC-119)', () => {
  it('projects onto the shared G01 audit shape with correct status', () => {
    const g = toG01AuditEvent(approvalAuditEvent(st(), T0 + 2000));
    expect(g.component).toBe('approvals');
    expect(g.status).toBe('ALLOWED');
    expect(g.identity.correlationId).toBe('corr-9');
    expect(g.evidenceIds).toContain('appr-1');
    expect(g.observedAtMs).toBe(T0 + 2000);
  });
  it('maps denied/pending statuses', () => {
    expect(toG01AuditEvent(approvalAuditEvent(st({ decision: deny }), T0 + 2000)).status).toBe('DENIED');
    expect(toG01AuditEvent(approvalAuditEvent(st({ decision: null }), T0 + 100)).status).toBe('NEEDS_APPROVAL');
  });
});
