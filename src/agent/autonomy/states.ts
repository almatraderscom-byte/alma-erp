/**
 * Autonomy decision states (G12 / SPEC-111).
 *
 * G11 answered "MAY this happen?" (policy). G12 answers a second, stricter
 * question for actions that policy allows: "may the agent do it ON ITS OWN, or
 * must it ask Boss first?" This module defines the finite autonomy state model
 * and the deterministic reducer that turns (policy decision + approval-rule
 * votes) into one of three terminal states:
 *
 *   AUTONOMOUS      → agent may act now (policy-allowed AND a rule says routine)
 *   NEEDS_APPROVAL  → agent must get owner approval before acting
 *   DENIED          → policy refused; the action never happens
 *
 * Fail-closed the RIGHT way for autonomy (INV-05): the safe default is to ASK,
 * not to act. An action nobody classified as routine, or that any rule flags,
 * resolves to NEEDS_APPROVAL. Only an explicit "routine + no flags" reaches
 * AUTONOMOUS. Concrete money/publishing/HR/export rules arrive in SPEC-113..116;
 * this spec is the state model + the reducer they plug into.
 *
 * Deterministic, pure: no LLM, no I/O (INV-01). Builds on the G11 PolicyDecision.
 */
import { z } from 'zod';
import {
  isSuccess,
  type ComponentResult,
  type ExecutionIdentity,
} from '@/agent/contracts';
import type { PolicyDecision } from '@/agent/policy';

/** The three terminal autonomy states. */
export type AutonomyState = 'AUTONOMOUS' | 'NEEDS_APPROVAL' | 'DENIED';

/** G12-local reason codes (append-only). */
export const AUTONOMY_REASON_CODES = {
  /** Policy refused the action outright (mirrors the G11 denial). */
  POLICY_DENIED: 'AUTONOMY_POLICY_DENIED',
  /** A rule flagged the action as requiring owner approval. */
  APPROVAL_REQUIRED: 'AUTONOMY_APPROVAL_REQUIRED',
  /** No rule classified the action as routine → ask, don't act (fail-closed). */
  UNCLASSIFIED_REQUIRES_APPROVAL: 'AUTONOMY_UNCLASSIFIED_REQUIRES_APPROVAL',
  /** Structurally invalid request. */
  MALFORMED_REQUEST: 'AUTONOMY_MALFORMED_REQUEST',
} as const;

export type AutonomyReasonCode =
  (typeof AUTONOMY_REASON_CODES)[keyof typeof AUTONOMY_REASON_CODES];

/** The action an autonomy decision is about. */
export interface ActionDescriptor {
  /** The verb, e.g. "wallet.debit", "facebook.publish". */
  action: string;
  /** Resource class the action targets, e.g. "wallet", "post". */
  resourceType: string;
  /** Optional instance id. */
  resourceId?: string;
  /** Attributes rules read (amountNano, audience, etc.). */
  attributes?: Record<string, unknown>;
}

/** What one autonomy decision evaluates. */
export interface AutonomyInput {
  identity: ExecutionIdentity;
  action: ActionDescriptor;
  /** The upstream G11 policy decision for this same action. */
  policyDecision: PolicyDecision;
  context?: Record<string, unknown>;
}

/** An approval rule's vote. `abstain` = "not my call" (does NOT grant autonomy). */
export type ApprovalEffect = 'require_approval' | 'autonomous_ok' | 'abstain';

export interface ApprovalVerdict {
  rule: string;
  effect: ApprovalEffect;
  reasonCodes: string[];
}

/**
 * A pluggable approval rule. Pure: same input → same verdict, never throws.
 * SPEC-113..116 implement concrete money/publishing/HR/export rules.
 */
export interface ApprovalRule {
  readonly name: string;
  evaluate(input: AutonomyInput): ApprovalVerdict;
}

/** The value returned when the agent may act autonomously. */
export interface AutonomyDecisionValue {
  state: 'AUTONOMOUS';
  action: string;
  /** Rule names that voted the action routine. */
  routineBy: string[];
}

export type AutonomyDecision = ComponentResult<AutonomyDecisionValue>;

// ── Validation ──────────────────────────────────────────────────────────────

const actionSchema = z.object({
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1).optional(),
  attributes: z.record(z.unknown()).optional(),
});

function needsApproval(reasonCodes: string[]): AutonomyDecision {
  return { status: 'NEEDS_APPROVAL', reasonCodes, evidenceIds: [] };
}
function denied(reasonCodes: string[]): AutonomyDecision {
  return { status: 'DENIED', reasonCodes, evidenceIds: [] };
}

/**
 * The deterministic autonomy engine. Holds an ordered, immutable rule list and
 * reduces (policy decision + rule votes) to a terminal autonomy state. Construct
 * once and reuse; no mutable state.
 */
export class AutonomyEngine {
  private readonly rules: readonly ApprovalRule[];

  constructor(rules: ApprovalRule[] = []) {
    this.rules = Object.freeze([...rules]);
  }

  ruleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /**
   * Decide autonomy. Never throws. Order (fail-closed):
   *   1. malformed action              → NEEDS_APPROVAL (safe: ask, don't act)
   *   2. policy did not ALLOW          → DENIED (never act on a non-allowed action)
   *   3. any rule requires approval    → NEEDS_APPROVAL (require overrides routine)
   *   4. ≥1 rule says routine, none require → AUTONOMOUS
   *   5. else (all abstain / no rules) → NEEDS_APPROVAL (unclassified ⇒ ask)
   */
  decide(input: AutonomyInput): AutonomyDecision {
    // 1. Structural validation. A malformed request is the least safe input, so
    //    it falls to the safe side: ask for approval, never act autonomously.
    if (!actionSchema.safeParse(input?.action).success) {
      return needsApproval([AUTONOMY_REASON_CODES.MALFORMED_REQUEST]);
    }

    // 2. Autonomy sits ON TOP of policy: if G11 did not ALLOW, autonomy is moot —
    //    the action is denied and never reaches an approval prompt.
    if (!isSuccess(input.policyDecision)) {
      return denied([AUTONOMY_REASON_CODES.POLICY_DENIED, ...input.policyDecision.reasonCodes]);
    }

    // 3. Run rules (pure).
    const requires: ApprovalVerdict[] = [];
    const routine: ApprovalVerdict[] = [];
    for (const rule of this.rules) {
      const v = rule.evaluate(input);
      if (v.effect === 'require_approval') requires.push(v);
      else if (v.effect === 'autonomous_ok') routine.push(v);
      // abstain → ignored (does NOT grant autonomy)
    }

    // 4. Require-approval overrides routine.
    if (requires.length > 0) {
      const codes = new Set<string>([AUTONOMY_REASON_CODES.APPROVAL_REQUIRED]);
      for (const r of requires) for (const c of r.reasonCodes) codes.add(c);
      return needsApproval([...codes]);
    }

    // 5. Explicit routine required for autonomy.
    if (routine.length > 0) {
      const value: AutonomyDecisionValue = {
        state: 'AUTONOMOUS',
        action: input.action.action,
        routineBy: routine.map((r) => r.rule),
      };
      return { status: 'ALLOWED', value, evidenceIds: [], versions: { autonomy: 'SPEC-111' } };
    }

    // 6. Fail-closed default: nobody said routine → ask Boss.
    return needsApproval([AUTONOMY_REASON_CODES.UNCLASSIFIED_REQUIRES_APPROVAL]);
  }
}

/** Convenience: build a one-shot engine and decide. */
export function decideAutonomy(input: AutonomyInput, rules: ApprovalRule[] = []): AutonomyDecision {
  return new AutonomyEngine(rules).decide(input);
}

/** The terminal state name for a decision (for audit/metrics). */
export function autonomyStateOf(decision: AutonomyDecision): AutonomyState {
  if (isSuccess(decision)) return 'AUTONOMOUS';
  return decision.status === 'DENIED' ? 'DENIED' : 'NEEDS_APPROVAL';
}
