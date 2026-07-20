/**
 * RBAC policy layer (G11 / SPEC-106).
 *
 * The first concrete `PolicyLayer` for the SPEC-105 engine. It maps a principal's
 * ROLES (or a credential's scopes) to a set of allowed `action` grants and votes
 * `permit` when the requested action is granted, `abstain` when it is not (so
 * another layer — ABAC/relationship — may still permit), and `deny` only for an
 * explicit role→action denial.
 *
 * Roles resolve through a versioned, in-memory `RoleBinding[]` — a pure data
 * table, NOT a database. Grants support exact actions and a trailing `*`
 * wildcard on a dotted namespace (e.g. `orders.*` grants `orders.read`).
 * Wildcards never cross a segment and a bare `*` grants everything (owner only,
 * by convention — the table is owner-authored).
 *
 * Deterministic, pure: no LLM, no I/O (INV-01). Fail-closed: an unknown role or
 * an ungranted action is `abstain`, never an implicit permit.
 */
import { z } from 'zod';
import { principalRoles, type Principal } from '@/agent/identity/principals';
import type { PolicyLayer, PolicyEvaluationInput, LayerVerdict } from './decision';

/** RBAC-local reason codes (append-only). */
export const RBAC_REASON_CODES = {
  ROLE_GRANTED: 'RBAC_ROLE_GRANTED',
  NO_ROLE_GRANT: 'RBAC_NO_ROLE_GRANT',
  ROLE_EXPLICIT_DENY: 'RBAC_ROLE_EXPLICIT_DENY',
} as const;

/**
 * A role's grants. `allow` and `deny` are action patterns (exact or `ns.*` /
 * `*`). `deny` wins over `allow` within RBAC (a role can carve out an exception).
 */
export interface RoleBinding {
  role: string;
  allow: string[];
  deny?: string[];
}

export const roleBindingSchema: z.ZodType<RoleBinding> = z.object({
  role: z.string().min(1),
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)).optional(),
}) as z.ZodType<RoleBinding>;

/** Does an action pattern match a requested action? `*`=all, `ns.*`=one namespace. */
export function actionMatches(pattern: string, action: string): boolean {
  if (pattern === action) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const ns = pattern.slice(0, -2);
    // `orders.*` matches `orders.read` and `orders.x.y` but NOT `orders` itself
    // and NOT `ordersX.read`.
    return action.startsWith(ns + '.');
  }
  return false;
}

/**
 * A versioned RBAC table. Construct from owner-authored bindings; immutable.
 * `roleTableVersion` is stamped so a policy decision can be replayed against the
 * exact table that produced it.
 */
export class RbacLayer implements PolicyLayer {
  readonly name = 'rbac';
  readonly version: string;
  private readonly byRole: ReadonlyMap<string, RoleBinding>;

  constructor(bindings: RoleBinding[], version = '1') {
    const map = new Map<string, RoleBinding>();
    for (const raw of bindings) {
      const parsed = roleBindingSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`invalid RoleBinding: ${parsed.error.issues[0]?.message}`);
      }
      // Last binding for a role wins; duplicates are a config smell but not fatal.
      map.set(parsed.data.role, parsed.data);
    }
    this.byRole = map;
    this.version = version;
  }

  evaluate(input: PolicyEvaluationInput): LayerVerdict {
    const roles = rolesOf(input.principal);
    let sawGrant = false;
    for (const role of roles) {
      const binding = this.byRole.get(role);
      if (!binding) continue; // unknown role → contributes nothing (fail-closed)
      // Explicit deny within any of the principal's roles overrides its grants.
      if ((binding.deny ?? []).some((p) => actionMatches(p, input.action))) {
        return {
          layer: this.name,
          effect: 'deny',
          reasonCodes: [RBAC_REASON_CODES.ROLE_EXPLICIT_DENY],
        };
      }
      if (binding.allow.some((p) => actionMatches(p, input.action))) sawGrant = true;
    }
    if (sawGrant) {
      return { layer: this.name, effect: 'permit', reasonCodes: [RBAC_REASON_CODES.ROLE_GRANTED] };
    }
    // No role granted the action → abstain (NOT permit). Another layer may allow;
    // if none does, the engine's fail-closed default denies.
    return { layer: this.name, effect: 'abstain', reasonCodes: [RBAC_REASON_CODES.NO_ROLE_GRANT] };
  }
}

/** Roles a principal carries (credentials expose scopes as roles — see G11). */
function rolesOf(principal: Principal): string[] {
  return principalRoles(principal);
}

/** Convenience builder. */
export function rbacLayer(bindings: RoleBinding[], version = '1'): RbacLayer {
  return new RbacLayer(bindings, version);
}
