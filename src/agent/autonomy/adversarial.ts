/**
 * Autonomy & approval adversarial certification (G12 / SPEC-120).
 *
 * The group's red-team gate. It wires the WHOLE stack — G11 policy → the autonomy
 * engine with all four approval rules (financial/publishing/HR/export) → the
 * SPEC-112 approval contract → SPEC-117 separation-of-duties → SPEC-118
 * lifecycle — and attacks it, asserting every dangerous path resolves to the safe
 * side. Each invariant is computed by actually driving the stack, not asserted by
 * prose (INV-10). If any invariant fails, the group must not certify.
 *
 * Deterministic, pure (INV-01): all time/amount inputs are constants.
 */
import { AutonomyEngine, autonomyStateOf, type AutonomyInput, type AutonomyState } from './states';
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';
import { financialApprovalRule } from '../approvals/financial-rule';
import { publishingApprovalRule } from '../approvals/publishing-rule';
import { hrApprovalRule } from '../approvals/hr-rule';
import { exportApprovalRule } from '../approvals/export-rule';
import { newApprovalRequest, type ApprovalDecisionInput } from '../approvals/contract';
import { resolveApprovalWithSod } from '../approvals/separation';
import { resolveUsable, type ApprovalLifecycleState } from '../approvals/lifecycle';

const TENANT = 'alma';
const REQUESTER = { tenantId: TENANT, actorId: 'agent-1', agentId: 'agent-1', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const CEILING = 100_000_000;
const T0 = 1_000_000, TTL = 60_000;
const SOD = { requiredApproverRoles: ['owner', 'approver'] };

const engine = new AutonomyEngine([
  financialApprovalRule({ autonomousCeilingNano: CEILING }),
  publishingApprovalRule(),
  hrApprovalRule(),
  exportApprovalRule({ autonomousRowCeiling: 100 }),
]);

function policyFor(action: string, allow = true): PolicyDecision {
  return decidePolicy(
    { identity: REQUESTER, principal: humanPrincipal(REQUESTER, ['staff']), action, resource: { type: action.split('.')[0], id: 'r', tenantId: TENANT } },
    allow ? [rbacLayer([{ role: 'staff', allow: ['*'] }])] : [rbacLayer([])],
  );
}
function autonomy(action: string, resourceType: string, attributes: Record<string, unknown> = {}, allow = true): AutonomyState {
  const input: AutonomyInput = { identity: REQUESTER, action: { action, resourceType, resourceId: 'r', attributes }, policyDecision: policyFor(action, allow) };
  return autonomyStateOf(engine.decide(input));
}

const boss = humanPrincipal({ ...REQUESTER, actorId: 'maruf' }, ['owner']);
function req() {
  return newApprovalRequest('appr-1', REQUESTER, { action: 'wallet.debit', resourceType: 'wallet', resourceId: 'w', attributes: { amountNano: CEILING * 2 } }, ['X'], T0, TTL);
}
function grant(over: Partial<ApprovalDecisionInput> = {}): ApprovalDecisionInput {
  return { approvalRequestId: 'appr-1', decision: 'grant', approver: boss, decidedAtMs: T0 + 1000, ...over };
}
function usableWithSod(state: ApprovalLifecycleState, now: number): boolean {
  // require BOTH lifecycle-usable AND SoD-eligible
  if (resolveUsable(state, now).status !== 'ALLOWED') return false;
  return resolveApprovalWithSod(state.request, state.decision, now, SOD).status === 'ALLOWED';
}

export interface FailClosedResult { invariant: string; ok: boolean }

/** Run every adversarial invariant; each `ok` means the stack stayed safe. */
export function runAutonomyFailClosedSuite(): FailClosedResult[] {
  const checks: Array<[string, () => boolean]> = [
    ['big money is never autonomous', () => autonomy('wallet.debit', 'wallet', { amountNano: CEILING + 1 }) === 'NEEDS_APPROVAL'],
    ['unknown money amount is never autonomous', () => autonomy('wallet.debit', 'wallet', {}) === 'NEEDS_APPROVAL'],
    ['float money amount is never autonomous', () => autonomy('wallet.debit', 'wallet', { amountNano: 1.5 }) === 'NEEDS_APPROVAL'],
    ['small verified money IS autonomous', () => autonomy('wallet.debit', 'wallet', { amountNano: 50_000 }) === 'AUTONOMOUS'],
    ['payroll always needs approval', () => autonomy('payroll.run', 'payroll', { amountNano: 1 }) === 'NEEDS_APPROVAL'],
    ['external publish needs approval', () => autonomy('facebook.publish', 'post', { audience: 'public' }) === 'NEEDS_APPROVAL'],
    ['unknown-audience publish needs approval', () => autonomy('facebook.publish', 'post', {}) === 'NEEDS_APPROVAL'],
    ['fire/hire needs approval', () => autonomy('fire.execute', 'staff', {}) === 'NEEDS_APPROVAL'],
    ['external export needs approval', () => autonomy('export.run', 'export', { destination: 'gdrive', rowCount: 1 }) === 'NEEDS_APPROVAL'],
    ['policy-denied action is DENIED, never autonomous/approval', () => autonomy('wallet.debit', 'wallet', { amountNano: 1 }, false) === 'DENIED'],
    ['unclassified action falls to approval (fail-closed default)', () => autonomy('mystery.act', 'mystery', {}) === 'NEEDS_APPROVAL'],
    ['no decision → not usable', () => !usableWithSod({ request: req(), decision: null }, T0 + 2000)],
    ['valid grant by eligible owner → usable', () => usableWithSod({ request: req(), decision: grant() }, T0 + 2000)],
    ['self-approval → not usable', () => !usableWithSod({ request: req(), decision: grant({ approver: humanPrincipal({ ...REQUESTER, actorId: 'agent-1' }, ['owner']) }) }, T0 + 2000)],
    ['agent approver → not usable', () => !usableWithSod({ request: req(), decision: grant({ approver: agentPrincipal({ ...REQUESTER, actorId: 'agent-9', agentId: 'agent-9' }, ['owner']) }) }, T0 + 2000)],
    ['approver without approver role → not usable', () => !usableWithSod({ request: req(), decision: grant({ approver: humanPrincipal({ ...REQUESTER, actorId: 'peer' }, ['staff']) }) }, T0 + 2000)],
    ['cross-tenant approver → not usable', () => !usableWithSod({ request: req(), decision: grant({ approver: humanPrincipal({ ...REQUESTER, tenantId: 'other', actorId: 'x' }, ['owner']) }) }, T0 + 2000)],
    ['expired grant → not usable', () => !usableWithSod({ request: req(), decision: grant() }, T0 + TTL + 1)],
    ['grant for a different request id → not usable', () => !usableWithSod({ request: req(), decision: grant({ approvalRequestId: 'other' }) }, T0 + 2000)],
    ['revoked grant → not usable', () => !usableWithSod({ request: req(), decision: grant(), revocation: { approvalRequestId: 'appr-1', revokedAtMs: T0 + 1500, byKey: 'k' } }, T0 + 2000)],
    ['consumed grant → not usable (no replay)', () => !usableWithSod({ request: req(), decision: grant(), consumption: { approvalRequestId: 'appr-1', consumedAtMs: T0 + 1600 } }, T0 + 2000)],
  ];
  return checks.map(([invariant, run]) => {
    let ok = false;
    try { ok = run(); } catch { ok = false; } // a throw is itself a failure (must never throw)
    return { invariant, ok };
  });
}

/** Certify the whole stack: true iff every adversarial invariant holds. */
export function certifyAutonomyFailClosed(): { ok: boolean; total: number; failed: string[] } {
  const results = runAutonomyFailClosedSuite();
  const failed = results.filter((r) => !r.ok).map((r) => r.invariant);
  return { ok: failed.length === 0, total: results.length, failed };
}
