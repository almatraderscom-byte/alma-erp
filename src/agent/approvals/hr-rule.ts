/**
 * HR and staff action approval rules (G12 / SPEC-115).
 *
 * Actions that affect PEOPLE — hiring, firing, salary changes, role changes,
 * disciplinary messages — are the most sensitive non-financial category and are
 * approval-gated by default. Routine, low-stakes staff interactions (a normal
 * task assignment, a routine Bangla notification) can be autonomous when the
 * owner explicitly allowlists them.
 *
 * The rule: an HR action in the always-approve set ⇒ require_approval; an HR
 * action explicitly allowlisted as routine ⇒ autonomous_ok; any other HR action
 * ⇒ require_approval (fail-closed); non-HR ⇒ abstain.
 *
 * Deterministic, pure (INV-01). Fail-closed (INV-05): unknown people-actions ask.
 */
import { z } from 'zod';
import type { ApprovalRule, ApprovalVerdict, AutonomyInput } from '../autonomy/states';

export const HR_REASON_CODES = {
  ALWAYS_APPROVE: 'HR_ALWAYS_APPROVE',
  UNCLASSIFIED_HR: 'HR_UNCLASSIFIED_REQUIRES_APPROVAL',
  ROUTINE_OK: 'HR_ROUTINE_OK',
} as const;

export interface HrRuleConfig {
  hrResourceTypes?: string[];
  hrActionPrefixes?: string[];
  /** HR actions that ALWAYS need approval (hire/fire/salary/role/discipline). */
  alwaysApprove?: string[];
  /** Exact HR actions the owner has allowlisted as routine/autonomous. */
  routineActions?: string[];
}

const DEFAULT_TYPES = ['staff', 'employee', 'payroll', 'hr'];
const DEFAULT_PREFIXES = ['staff.', 'employee.', 'hr.', 'hire.', 'fire.', 'salary.', 'role.'];
const DEFAULT_ALWAYS = ['hire', 'fire', 'salary', 'role', 'terminate', 'discipline', 'staff.remove', 'staff.role'];

const configSchema = z.object({
  hrResourceTypes: z.array(z.string().min(1)).optional(),
  hrActionPrefixes: z.array(z.string().min(1)).optional(),
  alwaysApprove: z.array(z.string().min(1)).optional(),
  routineActions: z.array(z.string().min(1)).optional(),
});

export class HrApprovalRule implements ApprovalRule {
  readonly name = 'hr';
  private readonly types: string[];
  private readonly prefixes: string[];
  private readonly always: string[];
  private readonly routine: Set<string>;

  constructor(config: HrRuleConfig = {}) {
    if (!configSchema.safeParse(config).success) throw new Error('invalid HrRuleConfig');
    this.types = config.hrResourceTypes ?? DEFAULT_TYPES;
    this.prefixes = config.hrActionPrefixes ?? DEFAULT_PREFIXES;
    this.always = config.alwaysApprove ?? DEFAULT_ALWAYS;
    this.routine = new Set(config.routineActions ?? []);
  }

  private isHr(action: string, resourceType: string): boolean {
    return this.types.includes(resourceType) || this.prefixes.some((p) => action.startsWith(p));
  }

  private isAlways(action: string, resourceType: string): boolean {
    return this.always.some((c) => resourceType === c || action === c || action.startsWith(c + '.') || action.includes(c));
  }

  evaluate(input: AutonomyInput): ApprovalVerdict {
    const { action, resourceType } = input.action;
    if (!this.isHr(action, resourceType)) {
      return { rule: this.name, effect: 'abstain', reasonCodes: [] };
    }
    if (this.isAlways(action, resourceType)) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [HR_REASON_CODES.ALWAYS_APPROVE] };
    }
    if (this.routine.has(action)) {
      return { rule: this.name, effect: 'autonomous_ok', reasonCodes: [HR_REASON_CODES.ROUTINE_OK] };
    }
    // Any other people-action → ask (fail-closed).
    return { rule: this.name, effect: 'require_approval', reasonCodes: [HR_REASON_CODES.UNCLASSIFIED_HR] };
  }
}

export function hrApprovalRule(config: HrRuleConfig = {}): HrApprovalRule {
  return new HrApprovalRule(config);
}
