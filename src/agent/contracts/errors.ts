/**
 * Canonical error taxonomy (G01 / SPEC-006).
 *
 * Turns every failure — validation, identity, tenant, budget, policy, approval,
 * dependency, timeout, or an uncaught throw — into a typed `ComponentFailure`
 * with a finite reason code and a definite retryability. This is how the system
 * honours "no untyped exceptions across a boundary" and "unknown outcomes enter
 * reconciliation, never blind retry" (INV-06). Deterministic, no I/O, no LLM.
 */
import {
  REASON_CODES,
  failure,
  type ComponentFailure,
  type FailureStatus,
  type ReasonCode,
} from './component';

export type ErrorCategory =
  | 'VALIDATION'
  | 'IDENTITY'
  | 'TENANT'
  | 'BUDGET'
  | 'POLICY'
  | 'APPROVAL'
  | 'TIMEOUT'
  | 'DEPENDENCY_RETRYABLE'
  | 'DEPENDENCY_FINAL'
  | 'UNKNOWN_OUTCOME'
  | 'INTERNAL';

interface CategorySpec {
  status: FailureStatus;
  reasonCode: ReasonCode;
  retryable: boolean;
}

/** The frozen mapping. Every category resolves to one status + reason + retry. */
export const ERROR_TAXONOMY: Record<ErrorCategory, CategorySpec> = {
  VALIDATION: { status: 'FAILED_FINAL', reasonCode: REASON_CODES.MALFORMED_INPUT, retryable: false },
  IDENTITY: { status: 'FAILED_FINAL', reasonCode: REASON_CODES.MISSING_ACTOR, retryable: false },
  TENANT: { status: 'DENIED', reasonCode: REASON_CODES.CROSS_TENANT, retryable: false },
  BUDGET: { status: 'BUDGET_EXCEEDED', reasonCode: REASON_CODES.BUDGET_EXCEEDED, retryable: false },
  POLICY: { status: 'DENIED', reasonCode: REASON_CODES.POLICY_DENIED, retryable: false },
  APPROVAL: { status: 'NEEDS_APPROVAL', reasonCode: REASON_CODES.APPROVAL_REQUIRED, retryable: false },
  TIMEOUT: { status: 'RETRYABLE', reasonCode: REASON_CODES.TIMEOUT, retryable: true },
  DEPENDENCY_RETRYABLE: { status: 'RETRYABLE', reasonCode: REASON_CODES.DEPENDENCY_RETRYABLE, retryable: true },
  DEPENDENCY_FINAL: { status: 'FAILED_FINAL', reasonCode: REASON_CODES.DEPENDENCY_FINAL, retryable: false },
  UNKNOWN_OUTCOME: { status: 'UNKNOWN_OUTCOME', reasonCode: REASON_CODES.UNKNOWN_OUTCOME, retryable: false },
  INTERNAL: { status: 'FAILED_FINAL', reasonCode: REASON_CODES.DEPENDENCY_FINAL, retryable: false },
};

/** Typed AIOS error. Carrying a category means it maps deterministically. */
export class AiosError extends Error {
  readonly category: ErrorCategory;
  readonly reasonCodes: ReasonCode[];
  readonly retryAfterMs?: number;
  readonly approvalRequestId?: string;

  constructor(
    category: ErrorCategory,
    message: string,
    opts: { reasonCodes?: ReasonCode[]; retryAfterMs?: number; approvalRequestId?: string } = {},
  ) {
    super(message);
    this.name = 'AiosError';
    this.category = category;
    this.reasonCodes = opts.reasonCodes ?? [ERROR_TAXONOMY[category].reasonCode];
    this.retryAfterMs = opts.retryAfterMs;
    this.approvalRequestId = opts.approvalRequestId;
  }
}

export function isRetryable(category: ErrorCategory): boolean {
  return ERROR_TAXONOMY[category].retryable;
}

/** Map an AiosError to its ComponentFailure. */
export function toComponentFailure(err: AiosError): ComponentFailure {
  const spec = ERROR_TAXONOMY[err.category];
  return failure(spec.status, err.reasonCodes, {
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    ...(err.approvalRequestId !== undefined ? { approvalRequestId: err.approvalRequestId } : {}),
  });
}

/**
 * Normalise ANY thrown value into a typed ComponentFailure. AiosError maps by
 * category; anything else becomes an INTERNAL FAILED_FINAL — never re-thrown,
 * never a silent success. This is the boundary net.
 */
export function normalizeError(e: unknown): ComponentFailure {
  if (e instanceof AiosError) return toComponentFailure(e);
  return failure(ERROR_TAXONOMY.INTERNAL.status, [ERROR_TAXONOMY.INTERNAL.reasonCode]);
}
