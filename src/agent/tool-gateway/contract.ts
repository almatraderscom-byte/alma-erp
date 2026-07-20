/**
 * G13 / SPEC-121 — Gateway request/result contract.
 *
 * The Central Secure Tool Gateway is the single door every external tool
 * side-effect passes through: a fixed pipeline of fail-closed stages. This module
 * freezes the CONTRACT — the typed request envelope, the mutable `GatewayContext`
 * threaded through the stages, the stage function shape, and the composer that
 * runs the stages in order and SHORT-CIRCUITS on the first non-success.
 *
 * Everything speaks the frozen G01 `ComponentResult<T>` union: no boolean success,
 * no thrown error crosses the boundary. Deterministic (INV-01): no LLM / DB /
 * network / clock / randomness in the gateway logic — those live behind the
 * execution ADAPTER seam (SPEC-127), faked in tests.
 */
import {
  type ComponentResult,
  type ExecutionIdentity,
  type ReasonCode,
  REASON_CODES,
  completed,
  failure,
  isSuccess,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import type { Principal } from '@/agent/identity/principals'
import type { PolicyResource } from '@/agent/policy'

export const GATEWAY_CONTRACT_VERSION = '1.0.0' as const

/**
 * The execution ADAPTER seam. Real adapters reach a provider/network; the gateway
 * logic never does. Tests inject a deterministic fake. Kept sync so the gateway
 * core is deterministic and pure (INV-01).
 */
export interface AdapterResult {
  payload: unknown
  actualCostNanoUsd?: number
}
export interface ExecutionAdapter {
  execute(input: { toolName: string; args: Record<string, unknown>; identity: ExecutionIdentity }): ComponentResult<AdapterResult>
}

/**
 * Injected dependency seams. Grows one stage at a time across G13 (policy layers,
 * budget store, evidence store, autonomy engine are added by their stage specs).
 * All are seams so the gateway stays deterministic and test-injectable.
 */
export interface GatewayDeps {
  adapter: ExecutionAdapter
  observedAtMs: number
  // SPEC-124 adds policyLayers; 125 budgetStore; 126 autonomyEngine; 128 evidenceStore.
  [k: string]: unknown
}

/** The state threaded through the pipeline. Stages read the request fields and
 * append their results (reservation, view, evidence, obligations, audit). */
export interface GatewayContext {
  identity: ExecutionIdentity
  contractVersion: string
  toolName: string
  args: Record<string, unknown>
  /** Policy action verb, e.g. "orders.write". */
  action: string
  estimatedCostNanoUsd: number
  observedAtMs: number
  deps: GatewayDeps
  /** Tenant the tool operates ON; must match identity.tenantId (cross-tenant guard, SPEC-123). */
  resourceTenantId?: string
  /** Authenticated principal + target resource for the policy stage (SPEC-124). */
  principal?: Principal
  resource?: PolicyResource
  policyContext?: Record<string, unknown>
  // ── accumulators (set by later stages) ──
  reservation?: { id: string; amountNanoUsd: number }
  obligations?: string[]
  rawPayload?: unknown
  evidenceId?: string
  view?: unknown
  actualCostNanoUsd?: number
  audit?: Record<string, unknown>
}

/** A pipeline stage: returns the advanced context, or a fail-closed failure. */
export type GatewayStage = (ctx: GatewayContext) => ComponentResult<GatewayContext>

/**
 * Run the stages in order. Fail-closed: the FIRST stage that returns a non-success
 * result stops the pipeline and that result is returned unchanged (DENIED /
 * NEEDS_APPROVAL / BUDGET_EXCEEDED / FAILED_FINAL propagate). Only if every stage
 * succeeds does the gateway complete.
 */
export function runPipeline(ctx: GatewayContext, stages: readonly GatewayStage[]): ComponentResult<GatewayContext> {
  let cur = ctx
  for (const stage of stages) {
    const r = stage(cur)
    if (!isSuccess(r)) {
      // Safety-net (SPEC-129): a stage aborted AFTER a cost reservation was made —
      // release it so a reserved budget is never leaked on the abort path.
      releaseReservation(cur)
      return r
    }
    cur = r.value
  }
  return completed(cur, cur.evidenceId ? [cur.evidenceId] : [], { gateway: GATEWAY_CONTRACT_VERSION })
}

/** Release a pending cost reservation (structural call — keeps the contract decoupled from G04). */
function releaseReservation(ctx: GatewayContext): void {
  const store = ctx.deps.budgetStore as { release?(id: string): void } | undefined
  if (ctx.reservation && store?.release) store.release(ctx.reservation.id)
}

/** Helper for stages: advance the context (COMPLETED with the updated ctx). */
export function advance(ctx: GatewayContext, patch: Partial<GatewayContext> = {}): ComponentResult<GatewayContext> {
  return completed({ ...ctx, ...patch }, [], { gateway: GATEWAY_CONTRACT_VERSION })
}

/** Helper for stages: fail closed with a finite reason code. */
export function stop(
  status: 'DENIED' | 'NEEDS_APPROVAL' | 'BUDGET_EXCEEDED' | 'RETRYABLE' | 'FAILED_FINAL' | 'UNKNOWN_OUTCOME',
  reasonCodes: ReasonCode[],
  opts: { approvalRequestId?: string; retryAfterMs?: number; evidenceIds?: string[] } = {},
): ComponentResult<GatewayContext> {
  return failure(status, reasonCodes, opts)
}

// ── Request boundary ────────────────────────────────────────────────────────

export interface GatewayResultValue {
  toolName: string
  evidenceId?: string
  view?: unknown
  obligations: string[]
  actualCostNanoUsd?: number
}

const gatewayPayloadSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()),
  action: z.string().min(1),
  estimatedCostNanoUsd: z.number().int().nonnegative().optional(),
  resourceTenantId: z.string().min(1).optional(),
})
export type GatewayPayload = z.infer<typeof gatewayPayloadSchema>

/**
 * Invoke a tool through the gateway. Validates the request envelope (identity +
 * contract version + payload), builds the context, and runs the pipeline. Returns
 * the frozen union — never throws.
 */
export function invokeTool(
  raw: unknown,
  deps: GatewayDeps,
  stages: readonly GatewayStage[],
): ComponentResult<GatewayResultValue> {
  const check = validateRequest(raw, gatewayPayloadSchema, GATEWAY_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const req = check.request
  const ctx: GatewayContext = {
    identity: req.identity,
    contractVersion: req.contractVersion,
    toolName: req.payload.toolName,
    args: req.payload.args as Record<string, unknown>,
    action: req.payload.action,
    estimatedCostNanoUsd: req.payload.estimatedCostNanoUsd ?? 0,
    observedAtMs: deps.observedAtMs,
    deps,
    ...(req.payload.resourceTenantId ? { resourceTenantId: req.payload.resourceTenantId } : {}),
  }
  const result = runPipeline(ctx, stages)
  if (!isSuccess(result)) return result
  const c = result.value
  return completed(
    { toolName: c.toolName, evidenceId: c.evidenceId, view: c.view, obligations: c.obligations ?? [], actualCostNanoUsd: c.actualCostNanoUsd },
    c.evidenceId ? [c.evidenceId] : [],
    { gateway: GATEWAY_CONTRACT_VERSION },
  )
}

export { REASON_CODES }
