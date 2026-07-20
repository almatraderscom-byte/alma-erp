/**
 * Policy and permission bypass suite (G19 / SPEC-189).
 *
 * A cross-cutting red-team over the composed authorization stack — G11 policy,
 * the G11 runtime guard, G12 autonomy + approval + separation-of-duties. It runs
 * concrete bypass ATTACKS end-to-end and asserts every one is blocked (fail-closed,
 * INV-05). If any attack succeeds, the release gate (SPEC-190) must fail.
 *
 * Deterministic, executable proof (INV-01, INV-10).
 */
import { decidePolicy, rbacLayer, runIfAuthorized } from '@/agent/policy';
import { completed, type ComponentResult } from '@/agent/contracts';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';
import { AutonomyEngine, type AutonomyInput } from '@/agent/autonomy/states';
import { financialApprovalRule } from '@/agent/approvals/financial-rule';
import { newApprovalRequest } from '@/agent/approvals/contract';
import { resolveApprovalWithSod } from '@/agent/approvals/separation';

const identity = { tenantId: 'alma', actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const SOD = { requiredApproverRoles: ['owner'] };

function sideEffectRan(): { ran: boolean; run: () => ComponentResult<string> } {
  const box = { ran: false };
  return { get ran() { return box.ran; }, run: () => { box.ran = true; return completed('did-it'); } } as unknown as { ran: boolean; run: () => ComponentResult<string> };
}

export interface BypassResult { attack: string; blocked: boolean }

export function runPolicyBypassSuite(): BypassResult[] {
  const checks: Array<[string, () => boolean]> = [
    ['cross-tenant principal is denied by policy', () => {
      const foreign = humanPrincipal({ ...identity, tenantId: 'other' }, ['staff']);
      const d = decidePolicy({ identity, principal: foreign, action: 'orders.read', resource: { type: 'order', id: 'o', tenantId: 'alma' } }, [rbacLayer([{ role: 'staff', allow: ['*'] }])]);
      return d.status === 'DENIED';
    }],
    ['no-permit (empty RBAC) fails closed to DENY', () => {
      const d = decidePolicy({ identity, principal: humanPrincipal(identity, ['staff']), action: 'orders.read', resource: { type: 'order', id: 'o', tenantId: 'alma' } }, [rbacLayer([])]);
      return d.status === 'DENIED';
    }],
    ['side effect never runs on a DENY (runtime guard)', () => {
      const d = decidePolicy({ identity, principal: humanPrincipal(identity, []), action: 'wallet.debit', resource: { type: 'wallet', id: 'w', tenantId: 'alma' } }, [rbacLayer([])]);
      const se = sideEffectRan();
      runIfAuthorized(d, se.run);
      return !se.ran;
    }],
    ['big money cannot go autonomous', () => {
      const eng = new AutonomyEngine([financialApprovalRule({ autonomousCeilingNano: 1000 })]);
      const input: AutonomyInput = { identity, action: { action: 'wallet.debit', resourceType: 'wallet', attributes: { amountNano: 999999 } }, policyDecision: decidePolicy({ identity, principal: humanPrincipal(identity, ['staff']), action: 'wallet.debit', resource: { type: 'wallet', id: 'w', tenantId: 'alma' } }, [rbacLayer([{ role: 'staff', allow: ['*'] }])]) };
      return eng.decide(input).status === 'NEEDS_APPROVAL';
    }],
    ['self-approval is rejected (SoD)', () => {
      const req = newApprovalRequest('a1', identity, { action: 'wallet.debit', resourceType: 'wallet', attributes: { amountNano: 1 } }, ['X'], 1000, 60000);
      const self = humanPrincipal({ ...identity, actorId: 'agent-1' }, ['owner']);
      return resolveApprovalWithSod(req, { approvalRequestId: 'a1', decision: 'grant', approver: self, decidedAtMs: 1500 }, 2000, SOD).status === 'DENIED';
    }],
    ['agent approver is rejected (SoD)', () => {
      const req = newApprovalRequest('a1', identity, { action: 'wallet.debit', resourceType: 'wallet', attributes: { amountNano: 1 } }, ['X'], 1000, 60000);
      const bot = agentPrincipal({ ...identity, actorId: 'a9', agentId: 'a9' }, ['owner']);
      return resolveApprovalWithSod(req, { approvalRequestId: 'a1', decision: 'grant', approver: bot, decidedAtMs: 1500 }, 2000, SOD).status === 'DENIED';
    }],
    ['approver without required role is rejected', () => {
      const req = newApprovalRequest('a1', identity, { action: 'wallet.debit', resourceType: 'wallet', attributes: { amountNano: 1 } }, ['X'], 1000, 60000);
      const peer = humanPrincipal({ ...identity, actorId: 'peer' }, ['staff']);
      return resolveApprovalWithSod(req, { approvalRequestId: 'a1', decision: 'grant', approver: peer, decidedAtMs: 1500 }, 2000, SOD).status === 'DENIED';
    }],
    ['expired approval cannot be used', () => {
      const req = newApprovalRequest('a1', identity, { action: 'wallet.debit', resourceType: 'wallet', attributes: { amountNano: 1 } }, ['X'], 1000, 60000);
      const boss = humanPrincipal({ ...identity, actorId: 'boss' }, ['owner']);
      return resolveApprovalWithSod(req, { approvalRequestId: 'a1', decision: 'grant', approver: boss, decidedAtMs: 1500 }, 1000 + 60000 + 1, SOD).status === 'DENIED';
    }],
  ];
  return checks.map(([attack, run]) => {
    let blocked = false;
    try { blocked = run(); } catch { blocked = false; }
    return { attack, blocked };
  });
}

export function certifyNoBypass(): { ok: boolean; total: number; leaked: string[] } {
  const results = runPolicyBypassSuite();
  const leaked = results.filter((r) => !r.blocked).map((r) => r.attack);
  return { ok: leaked.length === 0, total: results.length, leaked };
}
