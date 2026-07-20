import { describe, it, expect } from 'vitest';
import {
  newApprovalRequest, resolveApproval, approvalStateOf, APPROVAL_REASON_CODES,
  type ApprovalRequest, type ApprovalDecisionInput,
} from '../contract';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';
import type { ActionDescriptor } from '../../autonomy/states';

const identity = { tenantId: 'alma', actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const action: ActionDescriptor = { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w-1', attributes: { amountNano: 5_000 } };
const T0 = 1_000_000;
const TTL = 60_000;

const req = (): ApprovalRequest => newApprovalRequest('appr-1', identity, action, ['AUTONOMY_APPROVAL_REQUIRED'], T0, TTL);

const boss = humanPrincipal({ ...identity, actorId: 'maruf' }, ['owner']);
const grant = (over: Partial<ApprovalDecisionInput> = {}): ApprovalDecisionInput => ({
  approvalRequestId: 'appr-1', decision: 'grant', approver: boss, decidedAtMs: T0 + 1_000, ...over,
});

describe('newApprovalRequest (SPEC-112)', () => {
  it('sets a fail-closed expiry from ttl', () => {
    const r = req();
    expect(r.expiresAtMs).toBe(T0 + TTL);
  });
  it('throws on a malformed request', () => {
    expect(() => newApprovalRequest('', identity, action, [], T0, TTL)).toThrow();
  });
});

describe('resolveApproval — fail-closed (SPEC-112)', () => {
  it('PENDING when there is no decision yet', () => {
    const r = resolveApproval(req(), null, T0 + 100);
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.PENDING);
  });

  it('APPROVED on a valid in-window grant by an authorized human', () => {
    const r = resolveApproval(req(), grant(), T0 + 2_000);
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') {
      expect(r.value.approvalRequestId).toBe('appr-1');
      expect(r.value.approverKey).toBe('human:alma:maruf');
    }
  });

  it('DENIED when the approver denies', () => {
    const r = resolveApproval(req(), grant({ decision: 'deny' }), T0 + 2_000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.DENIED_BY_APPROVER);
  });

  it('DENIED (EXPIRED) once now is past expiry, even with a grant', () => {
    const r = resolveApproval(req(), grant(), T0 + TTL + 1);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.EXPIRED);
  });

  it('rejects a grant decided at/after expiry (out of window)', () => {
    const r = resolveApproval(req(), grant({ decidedAtMs: T0 + TTL }), T0 + TTL - 1);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.DECIDED_OUT_OF_WINDOW);
  });

  it('ignores a decision that targets a different request (no replay)', () => {
    const r = resolveApproval(req(), grant({ approvalRequestId: 'other' }), T0 + 2_000);
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.REQUEST_MISMATCH);
  });

  it('DENIES a cross-tenant approver', () => {
    const foreign = humanPrincipal({ ...identity, tenantId: 'other', actorId: 'x' }, ['owner']);
    const r = resolveApproval(req(), grant({ approver: foreign }), T0 + 2_000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.CROSS_TENANT_APPROVER);
  });

  it('DENIES a non-human approver (an agent cannot approve)', () => {
    const r = resolveApproval(req(), grant({ approver: agentPrincipal({ ...identity, actorId: 'agent-2', agentId: 'agent-2' }) }), T0 + 2_000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.UNAUTHORIZED_APPROVER);
  });

  it('DENIES self-approval (requester cannot approve its own action)', () => {
    const self = humanPrincipal({ ...identity, actorId: 'agent-1' }, ['owner']);
    const r = resolveApproval(req(), grant({ approver: self }), T0 + 2_000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(APPROVAL_REASON_CODES.SELF_APPROVAL);
  });

  it('does not throw on garbage', () => {
    expect(() => resolveApproval({} as ApprovalRequest, null, 0)).not.toThrow();
    expect(resolveApproval({} as ApprovalRequest, null, 0).status).toBe('DENIED');
  });
});

describe('approvalStateOf (SPEC-112)', () => {
  it('maps each lifecycle state', () => {
    expect(approvalStateOf(req(), null, T0 + 1)).toBe('PENDING');
    expect(approvalStateOf(req(), grant(), T0 + 2_000)).toBe('GRANTED');
    expect(approvalStateOf(req(), grant({ decision: 'deny' }), T0 + 2_000)).toBe('DENIED');
    expect(approvalStateOf(req(), grant(), T0 + TTL + 1)).toBe('EXPIRED');
  });
});
