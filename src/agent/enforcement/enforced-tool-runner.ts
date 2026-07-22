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
 * decision is identical for every model. Deterministic (INV-01). This additional
 * door deliberately fails OPEN only for unknown tool identities so a stale list
 * cannot break ordinary turns; the canonical registry/policy guards remain in
 * force. Gated by `AIOS_ENFORCE` so it is OFF in production until the owner turns
 * it on (preview first).
 */
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { agentPrincipal } from '@/agent/identity/principals';
import { AutonomyEngine, type AutonomyInput, type ApprovalRule } from '@/agent/autonomy/states';
import { financialApprovalRule } from '@/agent/approvals/financial-rule';
import { publishingApprovalRule } from '@/agent/approvals/publishing-rule';
import { hrApprovalRule } from '@/agent/approvals/hr-rule';
import { exportApprovalRule } from '@/agent/approvals/export-rule';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import { prisma } from '@/lib/prisma';
import { hashInput } from '@/agent/lib/policy/capability-token';

/** Is the mandatory door switched on? OFF by default (production-safe). */
export function enforcementEnabled(): boolean {
  const v = (process.env.AIOS_ENFORCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type ActionClass = 'financial' | 'publishing' | 'hr' | 'export' | 'routine';

/**
 * Exact pre-execution approval list. Every name exists in tools/registry.ts and
 * is a DIRECT owner-facing side effect. Tools classified as `stage` in the
 * registry are deliberately absent: their handler only creates its established
 * approval card, so blocking before that handler would prevent the real flow.
 *
 * Deliberate robustness rule approved by the owner: an unknown/new tool is
 * routine here (fail-open at this additional door). The canonical registry,
 * schema validation, authorization guard and the tool's own approval contract
 * still apply; AIOS may never break a normal turn merely because its list lags.
 */
export const SENSITIVE_TOOL_ALLOWLIST: Readonly<Record<string, ActionClass>> = Object.freeze({
  send_whatsapp: 'publishing',
  whatsapp_call: 'publishing',
  send_urgent_alert: 'publishing',
  camera_speak: 'publishing',
});

/** Classify a tool using exact identity only — never substring guessing. */
export function classifyTool(toolName: string): { action: string; resourceType: string; klass: ActionClass } {
  const n = toolName.trim().toLowerCase();
  const klass = SENSITIVE_TOOL_ALLOWLIST[n] ?? 'routine';
  if (klass === 'financial') return { action: `wallet.${n}`, resourceType: 'wallet', klass };
  if (klass === 'publishing') return { action: `publish.${n}`, resourceType: 'post', klass };
  if (klass === 'hr') return { action: `hr.${n}`, resourceType: 'staff', klass };
  if (klass === 'export') return { action: `export.${n}`, resourceType: 'export', klass };
  return { action: `tool.${n}`, resourceType: 'tool', klass: 'routine' };
}

/** Stage one exact held call. `dedupeKey` makes model retry/reconnect one card. */
export async function stageEnforcedToolApproval(input: {
  conversationId: string;
  businessId: string;
  turnId?: string | null;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  model: string;
  klass: Exclude<ActionClass, 'routine'>;
}): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    // Collapse provider retries even when the model assigns a NEW tool-call id:
    // one turn + exact tool + exact canonical payload = one intended effect/card.
    const dedupeKey = `aios:${input.turnId ?? input.conversationId}:${input.toolName}:${hashInput(input.toolInput)}`;
    const exactInput = JSON.stringify(input.toolInput);
    const summary = `${approvalMessage(input.klass)}\nAction: ${input.toolName}\nPayload: ${exactInput.slice(0, 1200)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentPendingAction.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        conversationId: input.conversationId,
        businessId: input.businessId,
        type: 'aios_enforced_tool',
        summary,
        payload: {
          toolName: input.toolName,
          toolInput: input.toolInput,
          model: input.model,
          sourceTurnId: input.turnId ?? null,
          sourceToolCallId: input.toolCallId,
          aiosEnforced: true,
        },
      },
      update: {},
    });
    return {
      success: true,
      data: {
        pendingActionId: row.id as string,
        summary: row.summary as string,
        actionType: 'aios_enforced_tool',
        awaitingApproval: true,
      },
    };
  } catch (err) {
    return { success: false, error: `AIOS approval hold failed: ${err instanceof Error ? err.message : String(err)}` };
  }
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
  // Tier-3 urgent alert already creates its own immutable `urgent_notify`
  // approval card. Let that staging handler run; wrapping it here would create
  // two approvals for one call. Tier-2 remains a direct effect and is held here.
  if (input.toolName.trim().toLowerCase() === 'send_urgent_alert'
      && Number(input.attributes?.tier) === 3) {
    return { allow: true, klass };
  }
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
