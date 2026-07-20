/**
 * Mandatory architecture enforcement for tool execution (live-wiring / phase 2).
 *
 * THE point of the whole roadmap: no matter which model is driving the turn
 * (Gemini, Claude, DeepSeek, Qwen, auto) — when it tries to DO something, it is
 * FORCED through the same guardrails before the action can run:
 *
 *   classify action → policy (G11) → autonomy + approval (G12) → [execute] → verify
 *
 * A sensitive action (money / publish / HR / data-export) can NOT run
 * autonomously — it returns NEEDS_APPROVAL and waits for the owner. A routine /
 * read action runs. The model is only the brain that asks; this door decides.
 *
 * Model-agnostic by construction: `model` is a label used for audit only — the
 * decision is identical for every model. Deterministic (INV-01), fail-closed
 * (INV-05). Gated by `AIOS_ENFORCE` so it is OFF in production until the owner
 * turns it on (preview first).
 */
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { agentPrincipal } from '@/agent/identity/principals';
import { AutonomyEngine, type AutonomyInput, type ApprovalRule } from '@/agent/autonomy/states';
import { financialApprovalRule } from '@/agent/approvals/financial-rule';
import { publishingApprovalRule } from '@/agent/approvals/publishing-rule';
import { hrApprovalRule } from '@/agent/approvals/hr-rule';
import { exportApprovalRule } from '@/agent/approvals/export-rule';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';

/** Is the mandatory door switched on? OFF by default (production-safe). */
export function enforcementEnabled(): boolean {
  const v = (process.env.AIOS_ENFORCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type ActionClass = 'financial' | 'publishing' | 'hr' | 'export' | 'routine';

/** Classify a tool into an action + resource type from its name (deterministic). */
export function classifyTool(toolName: string): { action: string; resourceType: string; klass: ActionClass } {
  const n = toolName.toLowerCase();
  const has = (...ks: string[]) => ks.some((k) => n.includes(k));
  if (has('refund', 'payout', 'payroll', 'wallet', 'payment', 'pay_', 'transfer', 'salary_pay', 'expense'))
    return { action: `wallet.${n}`, resourceType: 'wallet', klass: 'financial' };
  if (has('publish', 'facebook', 'instagram', 'whatsapp', 'post', 'broadcast', 'send_message', 'message_send', 'comment', 'ad_'))
    return { action: `publish.${n}`, resourceType: 'post', klass: 'publishing' };
  if (has('hire', 'fire', 'terminate', 'salary_set', 'staff_role', 'staff_remove', 'discipline'))
    return { action: `hr.${n}`, resourceType: 'staff', klass: 'hr' };
  if (has('export', 'download', 'dump', 'backup', 'share_external'))
    return { action: `export.${n}`, resourceType: 'export', klass: 'export' };
  return { action: `tool.${n}`, resourceType: 'tool', klass: 'routine' };
}

export type EnforcementDecision =
  | { allow: true; klass: ActionClass }
  | { allow: false; status: 'DENIED' | 'NEEDS_APPROVAL'; klass: ActionClass; reasonCodes: string[]; message: string };

/** Routine (non-sensitive) tools are safe to run autonomously; everything the
 * sensitive rules claim, they claim. This lets reads run while money/publish/HR/
 * export ask — without flipping the engine's safe default. */
const routineToolRule: ApprovalRule = {
  name: 'routine-tool',
  evaluate: (input) =>
    input.action.action.startsWith('tool.')
      ? { rule: 'routine-tool', effect: 'autonomous_ok', reasonCodes: ['ROUTINE_TOOL'] }
      : { rule: 'routine-tool', effect: 'abstain', reasonCodes: [] },
};

const engine = new AutonomyEngine([
  financialApprovalRule({ autonomousCeilingNano: Number(process.env.AIOS_AUTO_CEILING_NANO) || 0 }),
  publishingApprovalRule(),
  hrApprovalRule(),
  exportApprovalRule({ autonomousRowCeiling: Number(process.env.AIOS_EXPORT_ROW_CEILING) || 0 }),
  routineToolRule,
]);

/**
 * Decide whether a tool call may run, for ANY model. Pure + deterministic.
 * `attributes` carries amountNano / audience / rowCount etc. from the tool args
 * so the rules can judge; missing → fail-closed (asks).
 */
export function guardToolCall(input: {
  identity: ExecutionIdentity;
  model: string;
  toolName: string;
  attributes?: Record<string, unknown>;
}): EnforcementDecision {
  const { action, resourceType, klass } = classifyTool(input.toolName);
  const principal = agentPrincipal(input.identity, ['agent']); // the model acts on the owner's behalf

  // 1) Policy (G11): the agent principal is allowed to REQUEST agent actions;
  //    tenant isolation + fail-closed default handled inside decidePolicy.
  const policyDecision: PolicyDecision = decidePolicy(
    { identity: input.identity, principal, action, resource: { type: resourceType, tenantId: input.identity.tenantId } },
    [rbacLayer([{ role: 'agent', allow: ['tool.*', 'wallet.*', 'publish.*', 'hr.*', 'export.*'] }])],
  );
  if (policyDecision.status === 'DENIED') {
    return { allow: false, status: 'DENIED', klass, reasonCodes: policyDecision.reasonCodes, message: 'নীতিমালায় অনুমোদিত নয়।' };
  }

  // 2) Autonomy + approval (G12): sensitive ⇒ NEEDS_APPROVAL, routine ⇒ act.
  const autonomyInput: AutonomyInput = {
    identity: input.identity,
    action: { action, resourceType, attributes: input.attributes },
    policyDecision,
  };
  const decision = engine.decide(autonomyInput);
  if (isSuccess(decision)) return { allow: true, klass };
  if (decision.status === 'NEEDS_APPROVAL') {
    return {
      allow: false, status: 'NEEDS_APPROVAL', klass,
      reasonCodes: decision.reasonCodes,
      message: approvalMessage(klass),
    };
  }
  return { allow: false, status: 'DENIED', klass, reasonCodes: decision.reasonCodes, message: 'নিরাপত্তার কারণে থামানো হলো।' };
}

function approvalMessage(klass: ActionClass): string {
  switch (klass) {
    case 'financial': return 'Boss, এই টাকার কাজটা করার আগে আপনার অনুমতি দরকার। অনুমতি দিলে করে ফেলব।';
    case 'publishing': return 'Boss, এটা পাবলিকে যাবে — আপনার অনুমতি পেলে পোস্ট/পাঠাব।';
    case 'hr': return 'Boss, স্টাফ-সংক্রান্ত এই কাজটা আপনার অনুমতি ছাড়া করা যাবে না।';
    case 'export': return 'Boss, এই ডেটা এক্সপোর্টটা আপনার অনুমতি পেলে করব।';
    default: return 'Boss, এই কাজটা করার আগে আপনার অনুমতি দরকার।';
  }
}

/** A ToolResult-shaped block returned when the door refuses the call. */
export interface BlockedToolResult {
  success: false;
  error: string;
  errorCode: 'needs_approval' | 'policy_denied';
  retryable: false;
  enforcement: { status: string; klass: ActionClass; reasonCodes: string[]; model: string };
}

/**
 * Wrap the real tool executor. If enforcement is ON, the call is judged first and
 * a blocked ToolResult is returned for a sensitive/denied action WITHOUT running
 * it. If OFF, the real executor runs unchanged (production behaviour preserved).
 */
export async function enforcedExecuteTool<R>(
  args: { identity: ExecutionIdentity; model: string; toolName: string; attributes?: Record<string, unknown> },
  realExecute: () => Promise<R>,
): Promise<R | BlockedToolResult> {
  if (!enforcementEnabled()) return realExecute();
  const decision = guardToolCall(args);
  if (decision.allow) return realExecute();
  return {
    success: false,
    error: decision.message,
    errorCode: decision.status === 'NEEDS_APPROVAL' ? 'needs_approval' : 'policy_denied',
    retryable: false,
    enforcement: { status: decision.status, klass: decision.klass, reasonCodes: decision.reasonCodes, model: args.model },
  };
}
