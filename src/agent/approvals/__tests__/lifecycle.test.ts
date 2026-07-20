import { describe, it, expect } from 'vitest';
import { resolveUsable, isUsable, consumeApproval, revoke, LIFECYCLE_REASON_CODES, type ApprovalLifecycleState } from '../lifecycle';
import { newApprovalRequest, type ApprovalDecisionInput } from '../contract';
import { humanPrincipal } from '@/agent/identity/principals';
import type { ActionDescriptor } from '../../autonomy/states';

const identity = { tenantId: 'alma', actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const action: ActionDescriptor = { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w-1', attributes: { amountNano: 5000 } };
const T0 = 1_000_000, TTL = 60_000;
const req = () => newApprovalRequest('appr-1', identity, action, ['X'], T0, TTL);
const boss = humanPrincipal({ ...identity, actorId: 'maruf' }, ['owner']);
const grant: ApprovalDecisionInput = { approvalRequestId: 'appr-1', decision: 'grant', approver: boss, decidedAtMs: T0 + 1000 };
const base = (over: Partial<ApprovalLifecycleState> = {}): ApprovalLifecycleState => ({ request: req(), decision: grant, ...over });

describe('resolveUsable (SPEC-118)', () => {
  it('USABLE for a live, un-revoked, un-consumed grant', () => {
    expect(resolveUsable(base(), T0 + 2000).status).toBe('ALLOWED');
    expect(isUsable(base(), T0 + 2000)).toBe(true);
  });
  it('not usable after expiry', () => {
    const r = resolveUsable(base(), T0 + TTL + 1);
    expect(r.status).toBe('DENIED');
  });
  it('not usable once revoked (before now)', () => {
    const r = resolveUsable(base({ revocation: revoke('appr-1', T0 + 1500, 'human:alma:maruf') }), T0 + 2000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(LIFECYCLE_REASON_CODES.REVOKED);
  });
  it('still usable if revocation is scheduled in the future', () => {
    expect(resolveUsable(base({ revocation: revoke('appr-1', T0 + 5000, 'human:alma:maruf') }), T0 + 2000).status).toBe('ALLOWED');
  });
  it('a revocation for a different request is ignored', () => {
    expect(resolveUsable(base({ revocation: revoke('other', T0 + 1000, 'k') }), T0 + 2000).status).toBe('ALLOWED');
  });
  it('not usable once consumed (single-use, no replay)', () => {
    const r = resolveUsable(base({ consumption: { approvalRequestId: 'appr-1', consumedAtMs: T0 + 1600 } }), T0 + 2000);
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(LIFECYCLE_REASON_CODES.ALREADY_CONSUMED);
  });
  it('passes a pending base through (no decision)', () => {
    expect(resolveUsable(base({ decision: null }), T0 + 2000).status).toBe('NEEDS_APPROVAL');
  });
});

describe('consumeApproval (SPEC-118)', () => {
  it('mints a consumption record when usable', () => {
    const r = consumeApproval(base(), T0 + 2000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.consumption.consumedAtMs).toBe(T0 + 2000);
  });
  it('refuses to consume when not usable, returning the denial', () => {
    const r = consumeApproval(base({ consumption: { approvalRequestId: 'appr-1', consumedAtMs: T0 + 1600 } }), T0 + 2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.result.status).toBe('DENIED');
  });
  it('double-consume is impossible: 2nd attempt with the 1st record fails', () => {
    const first = consumeApproval(base(), T0 + 2000);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const second = consumeApproval(base({ consumption: first.consumption }), T0 + 2500);
      expect(second.ok).toBe(false);
    }
  });
});
