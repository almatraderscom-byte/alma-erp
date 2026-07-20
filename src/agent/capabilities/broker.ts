/**
 * G09 / SPEC-089 — Capability broker and fallback.
 *
 * The broker turns a resolved capability into a CONCRETE tool to invoke, with an
 * ordered fallback chain. It is fail-closed at every step:
 *   1. resolve the ranked capabilities for the intent+actor (SPEC-088),
 *   2. within each capability pick only CALLABLE tools (G08 deprecation:
 *      `removed` tools are excluded), ranked low-risk-first for a safe default,
 *   3. the first callable tool of the highest-ranked capability is the primary;
 *      every remaining callable tool (this capability then the next) is a fallback.
 * If NO callable tool exists anywhere, the broker DENIES — it never fabricates or
 * blindly retries an unknown target (INV-06 spirit).
 *
 * Deterministic, no LLM (INV-01). Uses G08 `callability` (decoupled) + `getManifest`.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { INTENT_CLASSES } from '@/agent/control-plane/admission/intent'
import { getManifest } from '@/agent/tools/manifests'
// Import from the decoupled G08 registry PACKAGE path explicitly: the bare
// specifier '@/agent/tools/registry' resolves to the monolith FILE (registry.ts),
// not this directory's barrel.
import { callability } from '@/agent/tools/registry/deprecation'
import { CAPABILITY_SCOPES } from './capability.schema'
import { capabilityStore } from './store'
import { resolveCapabilities, type ResolveInput } from './resolver'
import { effectiveHealth, isAvailable, type HealthOverrideStore } from './health'

export const BROKER_CONTRACT_VERSION = '1.0.0' as const

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }

/** Callable tools of a capability, ranked low-risk-first then name (stable). */
export function callableTools(capabilityKey: string): string[] {
  const cap = capabilityStore.getByKey(capabilityKey)
  if (!cap) return []
  return cap.toolNames
    .map(getManifest)
    .filter((m): m is NonNullable<typeof m> => m !== undefined && callability(m).callable)
    .sort((a, b) => (RISK_RANK[a.capability.risk] - RISK_RANK[b.capability.risk]) || a.name.localeCompare(b.name))
    .map((m) => m.name)
}

export interface BrokerSelection {
  capabilityKey: string
  toolName: string
  /** Ordered remaining callable tools (this capability, then lower-ranked ones). */
  fallbacks: string[]
}

/**
 * Select a concrete tool for an intent+actor. Returns null (fail-closed) when no
 * capability resolves or no capability has a callable tool.
 */
export function broker(input: ResolveInput, overrides?: HealthOverrideStore): BrokerSelection | null {
  const resolution = resolveCapabilities(input, overrides)
  if (!resolution.resolved) return null

  // Build the flat, ordered list of (capability, callable tool) pairs.
  const chain: Array<{ capabilityKey: string; toolName: string }> = []
  for (const cand of resolution.candidates) {
    const cap = capabilityStore.getByKey(cand.key)
    if (!cap) continue
    // Respect a runtime health override on the capability itself.
    if (!isAvailable(effectiveHealth(cap, overrides))) continue
    for (const tool of callableTools(cand.key)) chain.push({ capabilityKey: cand.key, toolName: tool })
  }
  if (chain.length === 0) return null
  const [primary, ...rest] = chain
  return {
    capabilityKey: primary.capabilityKey,
    toolName: primary.toolName,
    fallbacks: rest.map((c) => c.toolName),
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const brokerRequestSchema = z
  .object({
    intentKey: z.string().min(1).optional(),
    intentClass: z.enum(INTENT_CLASSES).optional(),
    actor: z.object({ roles: z.array(z.enum(CAPABILITY_SCOPES)) }),
    requireAvailable: z.boolean().optional(),
  })
  .refine((v) => v.intentKey !== undefined || v.intentClass !== undefined, { message: 'intentKey or intentClass required' })

export function brokerCapabilityRequest(raw: unknown): ComponentResult<BrokerSelection> {
  const check = validateRequest(raw, brokerRequestSchema, BROKER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const selection = broker(check.request.payload)
  if (!selection) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  return completed(selection, [], { broker: BROKER_CONTRACT_VERSION })
}
