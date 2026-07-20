/**
 * G09 / SPEC-084 — Capability permission metadata.
 *
 * Deterministic, FAIL-CLOSED authorization for a capability. Each capability
 * declares a required `scope` (owner|staff|customer) with a privilege order
 * owner > staff > customer: an actor may invoke a capability iff it holds a role
 * at least as privileged as the capability's scope. Anything unclear — no roles,
 * unknown role, disabled capability, kill-switched capability — is DENIED.
 *
 * This realises INV-05 (permissions fail closed). No LLM (INV-01): the decision
 * is a lattice comparison, never a model judgement.
 */
import {
  type ComponentResult,
  REASON_CODES,
  allowed,
  failure,
  validateRequest,
  type ReasonCode,
} from '@/agent/contracts'
import { z } from 'zod'
import { CAPABILITY_SCOPES, type Capability, type CapabilityScope } from './capability.schema'
import { capabilityStore } from './store'

export const PERMISSION_CONTRACT_VERSION = '1.0.0' as const

/** Privilege lattice: higher number = more privileged. */
const PRIVILEGE: Record<CapabilityScope, number> = { customer: 1, staff: 2, owner: 3 }

export interface ActorContext {
  /** Roles the actor holds (a subset of the capability scopes). */
  roles: CapabilityScope[]
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  requiredScope: CapabilityScope
  reasonCode?: ReasonCode
}

function maxPrivilege(roles: readonly CapabilityScope[]): number {
  return roles.reduce((acc, r) => Math.max(acc, PRIVILEGE[r] ?? 0), 0)
}

/**
 * Evaluate whether `actor` may invoke `capability`. Fail-closed:
 *  - a disabled or kill-switched capability is always DENIED,
 *  - an actor with no (or only insufficient) roles is DENIED,
 *  - only an actor whose max privilege ≥ the required scope is ALLOWED.
 */
export function evaluatePermission(capability: Capability, actor: ActorContext): PermissionDecision {
  const requiredScope = capability.permission.scope
  if (capability.status === 'disabled' || capability.health.killSwitch) {
    return { decision: 'deny', requiredScope, reasonCode: REASON_CODES.POLICY_DENIED }
  }
  const validRoles = actor.roles.filter((r): r is CapabilityScope => (CAPABILITY_SCOPES as readonly string[]).includes(r))
  if (validRoles.length === 0) {
    return { decision: 'deny', requiredScope, reasonCode: REASON_CODES.POLICY_DENIED }
  }
  const ok = maxPrivilege(validRoles) >= PRIVILEGE[requiredScope]
  return ok
    ? { decision: 'allow', requiredScope }
    : { decision: 'deny', requiredScope, reasonCode: REASON_CODES.POLICY_DENIED }
}

export interface PermissionIssue {
  capability: string
  code: 'DEFAULT_NOT_DENY' | 'MINROLE_MISMATCH' | 'UNKNOWN_SCOPE'
  detail: string
}

/** Metadata integrity of one capability's permission block. */
export function checkPermissionMetadata(c: Capability): PermissionIssue[] {
  const issues: PermissionIssue[] = []
  if (c.permission.defaultDecision !== 'deny') issues.push({ capability: c.key, code: 'DEFAULT_NOT_DENY', detail: c.permission.defaultDecision })
  if (!(CAPABILITY_SCOPES as readonly string[]).includes(c.permission.scope)) issues.push({ capability: c.key, code: 'UNKNOWN_SCOPE', detail: c.permission.scope })
  if (c.permission.minRole !== c.permission.scope) issues.push({ capability: c.key, code: 'MINROLE_MISMATCH', detail: `minRole=${c.permission.minRole} scope=${c.permission.scope}` })
  return issues
}

export function checkAllPermissionMetadata(caps: readonly Capability[] = capabilityStore.list()): PermissionIssue[] {
  return caps.flatMap(checkPermissionMetadata)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const permissionRequestSchema = z.object({
  capabilityKey: z.string().min(1),
  actor: z.object({ roles: z.array(z.enum(CAPABILITY_SCOPES)) }),
})

/**
 * Authorize a capability invocation. Returns ALLOWED or DENIED — the fail-closed
 * G01 union. An unknown capability is DENIED (never a throw, never a default-allow).
 */
export function authorizeCapability(raw: unknown): ComponentResult<{ requiredScope: CapabilityScope }> {
  const check = validateRequest(raw, permissionRequestSchema, PERMISSION_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const { capabilityKey, actor } = check.request.payload
  const cap = capabilityStore.getByKey(capabilityKey)
  if (!cap) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  const decision = evaluatePermission(cap, actor)
  if (decision.decision === 'allow') {
    return allowed({ requiredScope: decision.requiredScope }, [], { permission: PERMISSION_CONTRACT_VERSION })
  }
  return failure('DENIED', [decision.reasonCode ?? REASON_CODES.POLICY_DENIED])
}
