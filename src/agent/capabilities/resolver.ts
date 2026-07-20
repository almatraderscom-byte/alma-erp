/**
 * G09 / SPEC-088 — Capability resolver.
 *
 * Given an intent (business-intent key or G02 IntentClass) and an actor context,
 * deterministically resolve the ranked capabilities that CAN serve it. It composes
 * the earlier facets and is FAIL-CLOSED at every filter:
 *   1. intent match      (SPEC-082)
 *   2. permission ALLOW  (SPEC-084) — unpermitted capabilities are excluded
 *   3. availability      (SPEC-087) — disabled/kill-switched excluded
 * then ranks by cost tier (cheaper first) and key (stable). No surviving candidate
 * means `resolved: false` — the resolver never invents a capability.
 *
 * Deterministic, no LLM (INV-01): ranking is a comparator, not a model choice.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { INTENT_CLASSES, type IntentClass } from '@/agent/control-plane/admission'
import { CAPABILITY_SCOPES, CAPABILITY_TIERS, type Capability, type CapabilityScope } from './capability.schema'
import { capabilitiesForIntent, capabilitiesForClass } from './intent-map'
import { evaluatePermission, type ActorContext } from './permission'
import { effectiveHealth, isAvailable, type HealthOverrideStore } from './health'

export const RESOLVER_CONTRACT_VERSION = '1.0.0' as const

const TIER_RANK: Record<string, number> = { light: 0, standard: 1, heavy: 2 }

export interface ResolveInput {
  intentKey?: string
  intentClass?: IntentClass
  actor: ActorContext
  requireAvailable?: boolean
}

export interface RankedCapability {
  key: string
  tier: string
  scope: CapabilityScope
}

export interface ResolveResult {
  resolved: boolean
  candidates: RankedCapability[]
  /** Counts of why capabilities dropped out (diagnostics; not a leak). */
  considered: number
  deniedByPermission: number
  unavailable: number
}

function candidatesForIntent(input: ResolveInput): Capability[] {
  if (input.intentKey) return capabilitiesForIntent(input.intentKey)
  if (input.intentClass) return capabilitiesForClass(input.intentClass)
  return []
}

/** Deterministic resolution. Excludes (never returns) unpermitted / unavailable capabilities. */
export function resolveCapabilities(input: ResolveInput, overrides?: HealthOverrideStore): ResolveResult {
  const requireAvailable = input.requireAvailable !== false
  const considered = candidatesForIntent(input)
  let deniedByPermission = 0
  let unavailable = 0
  const surviving: Capability[] = []
  for (const c of considered) {
    if (evaluatePermission(c, input.actor).decision !== 'allow') {
      deniedByPermission += 1
      continue
    }
    if (requireAvailable && !isAvailable(effectiveHealth(c, overrides))) {
      unavailable += 1
      continue
    }
    surviving.push(c)
  }
  surviving.sort((a, b) => (TIER_RANK[a.cost.tier] - TIER_RANK[b.cost.tier]) || a.key.localeCompare(b.key))
  return {
    resolved: surviving.length > 0,
    candidates: surviving.map((c) => ({ key: c.key, tier: c.cost.tier, scope: c.permission.scope })),
    considered: considered.length,
    deniedByPermission,
    unavailable,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const resolveRequestSchema = z
  .object({
    intentKey: z.string().min(1).optional(),
    intentClass: z.enum(INTENT_CLASSES).optional(),
    actor: z.object({ roles: z.array(z.enum(CAPABILITY_SCOPES)) }),
    requireAvailable: z.boolean().optional(),
  })
  .refine((v) => v.intentKey !== undefined || v.intentClass !== undefined, { message: 'intentKey or intentClass required' })

export type ResolveResultValue = ResolveResult

/**
 * Resolve via the boundary. A request that resolves returns COMPLETED with the
 * ranked candidates; a request that matches NOTHING returns DENIED (fail-closed) —
 * the caller must not proceed without a capability.
 */
export function resolveCapabilityRequest(raw: unknown): ComponentResult<ResolveResultValue> {
  const check = validateRequest(raw, resolveRequestSchema, RESOLVER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const result = resolveCapabilities(check.request.payload)
  if (!result.resolved) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  return completed(result, [], { resolver: RESOLVER_CONTRACT_VERSION })
}

export const TIER_ORDER = CAPABILITY_TIERS
