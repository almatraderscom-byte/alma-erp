/**
 * Unified policy decision API (G11 / SPEC-105).
 *
 * The single deterministic authorization boundary. Given a validated
 * ExecutionIdentity, a Principal (WHO, from G11/SPEC-101..104), an action and a
 * resource, it returns a typed ComponentResult — `ALLOWED` with the value, or
 * `DENIED` with finite reason codes. There is NO ambiguous boolean and NO thrown
 * exception across the boundary.
 *
 * Fail-closed is the whole point (INV-05): the ONLY way to get ALLOW is for at
 * least one policy layer to explicitly permit AND for no layer to deny. Zero
 * layers, all-abstain, a malformed request, or a cross-tenant principal ALL
 * resolve to DENY. Layers themselves (RBAC/ABAC/relationship/obligations) arrive
 * in SPEC-106..109; this spec is the engine + combiner they plug into.
 *
 * Deterministic, pure: no LLM, no I/O, no DB, no network (INV-01).
 */
import { z } from 'zod';
import {
  allowed,
  REASON_CODES,
  executionIdentitySchema,
  type ComponentResult,
  type ComponentFailure,
  type ExecutionIdentity,
} from '@/agent/contracts';
import { type Principal, principalKey } from '@/agent/identity/principals';

/** G11-local reason codes (append-only). Contract codes stay in G01. */
export const POLICY_REASON_CODES = {
  /** Request envelope failed structural validation. */
  MALFORMED_REQUEST: 'POLICY_MALFORMED_REQUEST',
  /** Principal's tenant differs from the operation's tenant. */
  PRINCIPAL_TENANT_MISMATCH: 'POLICY_PRINCIPAL_TENANT_MISMATCH',
  /** Resource's tenant differs from the operation's tenant. */
  RESOURCE_TENANT_MISMATCH: 'POLICY_RESOURCE_TENANT_MISMATCH',
  /** No layer explicitly permitted (fail-closed default). */
  NO_APPLICABLE_PERMIT: 'POLICY_NO_APPLICABLE_PERMIT',
  /** A layer explicitly denied (deny overrides permit). */
  EXPLICIT_DENY: 'POLICY_EXPLICIT_DENY',
} as const;

export type PolicyReasonCode =
  (typeof POLICY_REASON_CODES)[keyof typeof POLICY_REASON_CODES];

/** The resource an action targets. */
export interface PolicyResource {
  /** Resource class, e.g. "order", "wallet", "customer". Required. */
  type: string;
  /** Specific instance id, if the action is instance-scoped. */
  id?: string;
  /** Owning tenant; when present it must equal the operation's tenant. */
  tenantId?: string;
  /** Arbitrary attributes consumed by ABAC/relationship layers (SPEC-107/108). */
  attributes?: Record<string, unknown>;
}

/** What a single decision evaluates. */
export interface PolicyEvaluationInput {
  identity: ExecutionIdentity;
  principal: Principal;
  /** The verb, e.g. "orders.read", "wallet.debit". Required, non-empty. */
  action: string;
  resource: PolicyResource;
  /** Environmental attributes (time, channel, risk) for ABAC (SPEC-107). */
  context?: Record<string, unknown>;
}

/** A layer's vote. `abstain` = "not my call" (does NOT grant access). */
export type LayerEffect = 'permit' | 'deny' | 'abstain';

export interface LayerVerdict {
  layer: string;
  effect: LayerEffect;
  /** Finite reason codes explaining a deny (or a conditional permit). */
  reasonCodes: string[];
  /** Obligations attached to a permit (redaction etc. — consumed by SPEC-109). */
  obligations?: string[];
}

/**
 * A pluggable policy layer. Pure: same input → same verdict. Layers must NEVER
 * throw; a layer that cannot decide returns `abstain`. RBAC/ABAC/relationship/
 * obligation layers (SPEC-106..109) implement this interface.
 */
export interface PolicyLayer {
  readonly name: string;
  evaluate(input: PolicyEvaluationInput): LayerVerdict;
}

/** The value returned on ALLOW. */
export interface PolicyDecisionValue {
  effect: 'ALLOW';
  action: string;
  principalKey: string;
  /** Layer names that voted permit. */
  permittedBy: string[];
  /** Union of obligations from permitting layers (empty until SPEC-109). */
  obligations: string[];
}

export type PolicyDecision = ComponentResult<PolicyDecisionValue>;

// ── Input validation (structural; fail-closed) ──────────────────────────────

const resourceSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const principalTenantSchema = z.object({
  kind: z.enum(['human', 'agent', 'workflow', 'credential']),
  tenantId: z.string().min(1),
});

const evaluationInputSchema = z.object({
  identity: executionIdentitySchema,
  principal: principalTenantSchema.passthrough(),
  action: z.string().min(1),
  resource: resourceSchema,
  context: z.record(z.unknown()).optional(),
});

function denied(reasonCodes: string[]): ComponentFailure {
  // Built directly (not via failure()) because policy carries G11-local reason
  // codes alongside the G01 contract codes; the union is intentionally `string[]`.
  // Non-empty by construction — a denial always carries a concrete reason.
  return { status: 'DENIED', reasonCodes, evidenceIds: [] };
}

/**
 * The deterministic policy engine. Holds an ordered, immutable list of layers
 * and combines their verdicts fail-closed. Construct once per policy version and
 * reuse; it holds no mutable state.
 */
export class PolicyEngine {
  private readonly layers: readonly PolicyLayer[];

  constructor(layers: PolicyLayer[] = []) {
    // Defensive copy — callers cannot mutate the engine's layer set after build.
    this.layers = Object.freeze([...layers]);
  }

  /** Registered layer names, in evaluation order. */
  layerNames(): string[] {
    return this.layers.map((l) => l.name);
  }

  /**
   * Decide a single (principal, action, resource) request. Never throws.
   * Combining rule (fail-closed, deny-overrides, explicit-permit-required):
   *   1. any layer denies            → DENY (deny overrides everything)
   *   2. else ≥1 layer permits       → ALLOW (with union of obligations)
   *   3. else (all abstain / none)   → DENY (NO_APPLICABLE_PERMIT default)
   */
  decide(input: PolicyEvaluationInput): PolicyDecision {
    // 1. Structural validation — a malformed request is a DENY, not a throw.
    const parsed = evaluationInputSchema.safeParse(input);
    if (!parsed.success) {
      return denied([POLICY_REASON_CODES.MALFORMED_REQUEST]);
    }

    // 2. Tenant isolation — the principal and the resource must live in the
    //    operation's tenant. A mismatch is a hard cross-tenant denial and is
    //    checked BEFORE any layer runs (defence in depth; INV-02).
    if (input.principal.tenantId !== input.identity.tenantId) {
      return denied([
        REASON_CODES.CROSS_TENANT,
        POLICY_REASON_CODES.PRINCIPAL_TENANT_MISMATCH,
      ]);
    }
    if (
      input.resource.tenantId !== undefined &&
      input.resource.tenantId !== input.identity.tenantId
    ) {
      return denied([
        REASON_CODES.CROSS_TENANT,
        POLICY_REASON_CODES.RESOURCE_TENANT_MISMATCH,
      ]);
    }

    // 3. Run every layer (pure). Collect verdicts; short-circuit is unnecessary
    //    since layers are cheap and deny-overrides needs the deny reasons.
    const permits: LayerVerdict[] = [];
    const denies: LayerVerdict[] = [];
    for (const layer of this.layers) {
      const verdict = layer.evaluate(input);
      if (verdict.effect === 'deny') denies.push(verdict);
      else if (verdict.effect === 'permit') permits.push(verdict);
      // abstain → ignored (does not grant)
    }

    // 4a. Deny overrides.
    if (denies.length > 0) {
      const codes = new Set<string>([POLICY_REASON_CODES.EXPLICIT_DENY]);
      for (const d of denies) for (const c of d.reasonCodes) codes.add(c);
      return denied([...codes]);
    }

    // 4b. Explicit permit required.
    if (permits.length > 0) {
      const obligations = new Set<string>();
      for (const p of permits) for (const o of p.obligations ?? []) obligations.add(o);
      const value: PolicyDecisionValue = {
        effect: 'ALLOW',
        action: input.action,
        principalKey: principalKey(input.principal),
        permittedBy: permits.map((p) => p.layer),
        obligations: [...obligations],
      };
      return allowed(value, [], { policy: 'SPEC-105' });
    }

    // 4c. Fail-closed default: nobody permitted.
    return denied([POLICY_REASON_CODES.NO_APPLICABLE_PERMIT]);
  }
}

/** Convenience: build a one-shot engine and decide. */
export function decidePolicy(
  input: PolicyEvaluationInput,
  layers: PolicyLayer[] = [],
): PolicyDecision {
  return new PolicyEngine(layers).decide(input);
}
