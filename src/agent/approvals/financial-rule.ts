/**
 * Financial action approval rules (G12 / SPEC-113).
 *
 * The first concrete `ApprovalRule` for the autonomy engine (SPEC-111). Money
 * movement is the highest-stakes thing the agent can do, so this rule is
 * deliberately conservative: a financial action is AUTONOMOUS only when its
 * amount is known, a whole non-negative nano-USD integer, at or below the
 * owner-set ceiling, and not in the always-approve set (e.g. payroll). Anything
 * else — unknown/malformed amount, over the ceiling, or an always-approve
 * category — votes `require_approval`. Non-financial actions `abstain`.
 *
 * Money is integer nano-USD only (no floats, no BDT) — consistent with G03/G04.
 * Deterministic, pure: no LLM, no I/O (INV-01). Fail-closed (INV-05): when the
 * amount cannot be verified, ASK — never act.
 */
import { z } from 'zod';
import type { ApprovalRule, ApprovalVerdict, AutonomyInput } from '../autonomy/states';

export const FINANCIAL_REASON_CODES = {
  OVER_CEILING: 'FINANCIAL_OVER_CEILING',
  AMOUNT_UNKNOWN: 'FINANCIAL_AMOUNT_UNKNOWN',
  ALWAYS_APPROVE: 'FINANCIAL_ALWAYS_APPROVE',
  WITHIN_CEILING: 'FINANCIAL_WITHIN_CEILING',
} as const;

export interface FinancialRuleConfig {
  /** Financial actions at/below this nano-USD amount may be autonomous. */
  autonomousCeilingNano: number;
  /** Resource types treated as financial (default: wallet/payment/payroll/…). */
  financialResourceTypes?: string[];
  /** Action namespaces treated as financial (default: wallet./payment./…). */
  financialActionPrefixes?: string[];
  /** Categories that ALWAYS need approval regardless of amount (e.g. payroll). */
  alwaysApprove?: string[];
}

const DEFAULT_FINANCIAL_TYPES = ['wallet', 'payment', 'payroll', 'refund', 'transfer', 'expense'];
const DEFAULT_FINANCIAL_PREFIXES = ['wallet.', 'payment.', 'payroll.', 'refund.', 'transfer.', 'expense.'];

const configSchema = z.object({
  autonomousCeilingNano: z.number().int().nonnegative(),
  financialResourceTypes: z.array(z.string().min(1)).optional(),
  financialActionPrefixes: z.array(z.string().min(1)).optional(),
  alwaysApprove: z.array(z.string().min(1)).optional(),
});

/** Read a strictly-valid nano-USD amount, or null if absent/invalid. */
export function readAmountNano(attributes: Record<string, unknown> | undefined): number | null {
  const raw = attributes?.amountNano;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

export class FinancialApprovalRule implements ApprovalRule {
  readonly name = 'financial';
  private readonly cfg: Required<Omit<FinancialRuleConfig, never>>;

  constructor(config: FinancialRuleConfig) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new Error(`invalid FinancialRuleConfig: ${parsed.error.issues[0]?.message}`);
    this.cfg = {
      autonomousCeilingNano: config.autonomousCeilingNano,
      financialResourceTypes: config.financialResourceTypes ?? DEFAULT_FINANCIAL_TYPES,
      financialActionPrefixes: config.financialActionPrefixes ?? DEFAULT_FINANCIAL_PREFIXES,
      alwaysApprove: config.alwaysApprove ?? ['payroll'],
    };
  }

  private isFinancial(action: string, resourceType: string): boolean {
    if (this.cfg.financialResourceTypes.includes(resourceType)) return true;
    return this.cfg.financialActionPrefixes.some((p) => action.startsWith(p));
  }

  private isAlwaysApprove(action: string, resourceType: string): boolean {
    return this.cfg.alwaysApprove.some(
      (c) => resourceType === c || action === c || action.startsWith(c + '.'),
    );
  }

  evaluate(input: AutonomyInput): ApprovalVerdict {
    const { action, resourceType, attributes } = input.action;
    if (!this.isFinancial(action, resourceType)) {
      return { rule: this.name, effect: 'abstain', reasonCodes: [] };
    }
    // Always-approve categories bypass the amount check entirely.
    if (this.isAlwaysApprove(action, resourceType)) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [FINANCIAL_REASON_CODES.ALWAYS_APPROVE] };
    }
    // Fail-closed: an unverifiable amount is never autonomous.
    const amount = readAmountNano(attributes);
    if (amount === null) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [FINANCIAL_REASON_CODES.AMOUNT_UNKNOWN] };
    }
    if (amount > this.cfg.autonomousCeilingNano) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [FINANCIAL_REASON_CODES.OVER_CEILING] };
    }
    return { rule: this.name, effect: 'autonomous_ok', reasonCodes: [FINANCIAL_REASON_CODES.WITHIN_CEILING] };
  }
}

export function financialApprovalRule(config: FinancialRuleConfig): FinancialApprovalRule {
  return new FinancialApprovalRule(config);
}
