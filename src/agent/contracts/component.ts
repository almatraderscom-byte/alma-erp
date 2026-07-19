/**
 * AIOS canonical component contract (G01 / SPEC-001).
 *
 * Every AIOS boundary — Admission Control, Cost Governor, Context Compiler,
 * Capability Broker, Policy/Approval, Durable Workflow, Secure Tool Gateway,
 * Evidence Verification, Response Gate — speaks this request/result shape.
 *
 * Design rules (from GLOBAL_AGENT_CONTRACT.md):
 *  - No ambiguous boolean success. Results are a typed discriminated union.
 *  - No untyped exceptions across a boundary. Failures carry finite reason codes.
 *  - Every authoritative operation carries a full ExecutionIdentity.
 *
 * This module is deterministic and has ZERO runtime dependencies on providers,
 * models, tools, the database or the network. It is pure types + zod validation.
 */
import { z } from 'zod';

/** Contract version stamped onto every request/result for this module. */
export const COMPONENT_CONTRACT_VERSION = '1.0.0' as const;

/**
 * Canonical execution identity. Every authoritative operation must carry one.
 * SPEC-004 canonicalises the builder/validator on top of this shape.
 */
export interface ExecutionIdentity {
  tenantId: string;
  businessId?: string;
  actorId: string;
  agentId?: string;
  workflowId: string;
  stepId: string;
  correlationId: string;
}

/** Envelope for a request into any AIOS component. */
export interface ComponentRequest<T> {
  identity: ExecutionIdentity;
  contractVersion: string;
  payload: T;
  policyVersion?: string;
  budgetId?: string;
}

/** Terminal success states. */
export type SuccessStatus = 'COMPLETED' | 'ALLOWED';

/** Terminal / non-success states. All are explicit — never a thrown value. */
export type FailureStatus =
  | 'DENIED'
  | 'NEEDS_APPROVAL'
  | 'BUDGET_EXCEEDED'
  | 'RETRYABLE'
  | 'FAILED_FINAL'
  | 'UNKNOWN_OUTCOME';

export interface ComponentSuccess<T> {
  status: SuccessStatus;
  value: T;
  evidenceIds: string[];
  versions: Record<string, string>;
}

export interface ComponentFailure {
  status: FailureStatus;
  reasonCodes: string[];
  evidenceIds: string[];
  retryAfterMs?: number;
  approvalRequestId?: string;
}

export type ComponentResult<T> = ComponentSuccess<T> | ComponentFailure;

/**
 * Finite, stable reason codes. Downstream systems map on these strings, so the
 * set is closed and additions are append-only (never renamed / removed).
 */
export const REASON_CODES = {
  MISSING_TENANT: 'MISSING_TENANT',
  MISSING_ACTOR: 'MISSING_ACTOR',
  MISSING_WORKFLOW: 'MISSING_WORKFLOW',
  MISSING_STEP: 'MISSING_STEP',
  MISSING_CORRELATION: 'MISSING_CORRELATION',
  MALFORMED_INPUT: 'MALFORMED_INPUT',
  OVERSIZED_INPUT: 'OVERSIZED_INPUT',
  CONTRACT_VERSION_MISMATCH: 'CONTRACT_VERSION_MISMATCH',
  TIMEOUT: 'TIMEOUT',
  DEPENDENCY_RETRYABLE: 'DEPENDENCY_RETRYABLE',
  DEPENDENCY_FINAL: 'DEPENDENCY_FINAL',
  CROSS_TENANT: 'CROSS_TENANT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

/** Audit event emitted for every authoritative operation. */
export interface AuditEvent {
  identity: ExecutionIdentity;
  component: string;
  status: SuccessStatus | FailureStatus;
  reasonCodes: string[];
  evidenceIds: string[];
  contractVersion: string;
  /** epoch millis; supplied by caller so this module stays deterministic */
  observedAtMs: number;
}

/** Metric fields recorded per operation (see SPEC cost verification). */
export interface OperationMetrics {
  component: string;
  status: SuccessStatus | FailureStatus;
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedUsd: number;
  actualUsd: number;
  latencyMs: number;
}

// ── Runtime validation ──────────────────────────────────────────────────────

export const executionIdentitySchema = z.object({
  tenantId: z.string().min(1),
  businessId: z.string().min(1).optional(),
  actorId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  correlationId: z.string().min(1),
});

export function componentRequestSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    identity: executionIdentitySchema,
    contractVersion: z.string().min(1),
    payload,
    policyVersion: z.string().min(1).optional(),
    budgetId: z.string().min(1).optional(),
  });
}

/** Upper bound on serialized payload size accepted by a boundary (256 KiB). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

// ── Result constructors (never throw across a boundary) ─────────────────────

export function completed<T>(
  value: T,
  evidenceIds: string[] = [],
  versions: Record<string, string> = {},
): ComponentSuccess<T> {
  return { status: 'COMPLETED', value, evidenceIds, versions };
}

export function allowed<T>(
  value: T,
  evidenceIds: string[] = [],
  versions: Record<string, string> = {},
): ComponentSuccess<T> {
  return { status: 'ALLOWED', value, evidenceIds, versions };
}

export function failure(
  status: FailureStatus,
  reasonCodes: ReasonCode[],
  opts: { evidenceIds?: string[]; retryAfterMs?: number; approvalRequestId?: string } = {},
): ComponentFailure {
  return {
    status,
    reasonCodes,
    evidenceIds: opts.evidenceIds ?? [],
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    ...(opts.approvalRequestId !== undefined ? { approvalRequestId: opts.approvalRequestId } : {}),
  };
}

export function isSuccess<T>(r: ComponentResult<T>): r is ComponentSuccess<T> {
  return r.status === 'COMPLETED' || r.status === 'ALLOWED';
}

/**
 * Validate a request envelope against a payload schema and the boundary rules
 * (identity present, contract version matches, payload within size bound).
 * Returns a typed request or a ComponentFailure — never throws.
 */
export function validateRequest<T>(
  raw: unknown,
  payloadSchema: z.ZodType<T>,
  expectedContractVersion: string = COMPONENT_CONTRACT_VERSION,
): { ok: true; request: ComponentRequest<T> } | { ok: false; failure: ComponentFailure } {
  const parsed = componentRequestSchema(payloadSchema).safeParse(raw);
  if (!parsed.success) {
    const reasons = mapZodToReasonCodes(parsed.error);
    return { ok: false, failure: failure('FAILED_FINAL', reasons) };
  }
  const request = parsed.data as ComponentRequest<T>;

  if (request.contractVersion !== expectedContractVersion) {
    return {
      ok: false,
      failure: failure('FAILED_FINAL', [REASON_CODES.CONTRACT_VERSION_MISMATCH]),
    };
  }

  const size = Buffer.byteLength(JSON.stringify(request.payload ?? null), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, failure: failure('FAILED_FINAL', [REASON_CODES.OVERSIZED_INPUT]) };
  }

  return { ok: true, request };
}

/** Map a zod error to finite reason codes (identity fields → specific codes). */
export function mapZodToReasonCodes(error: z.ZodError): ReasonCode[] {
  const codes = new Set<ReasonCode>();
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (path === 'identity.tenantId') codes.add(REASON_CODES.MISSING_TENANT);
    else if (path === 'identity.actorId') codes.add(REASON_CODES.MISSING_ACTOR);
    else if (path === 'identity.workflowId') codes.add(REASON_CODES.MISSING_WORKFLOW);
    else if (path === 'identity.stepId') codes.add(REASON_CODES.MISSING_STEP);
    else if (path === 'identity.correlationId') codes.add(REASON_CODES.MISSING_CORRELATION);
    else codes.add(REASON_CODES.MALFORMED_INPUT);
  }
  return [...codes];
}
