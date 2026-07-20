/**
 * G09 / SPEC-081 — Capability data model.
 *
 * A Capability is a coarse BUSINESS ABILITY (e.g. "finance", "customer service")
 * that sits above G08 tools: it maps user intent (G02) down to concrete tools
 * (G08 manifests) and carries the control-plane metadata the head needs to route,
 * authorize, cost and health-check a request WITHOUT importing any handler.
 *
 * This module freezes the SHAPE of a Capability + its sub-facets. Later G09 specs
 * add the LOGIC over each facet:
 *   intents/intentClasses → SPEC-082   toolNames → SPEC-083   permission → SPEC-084
 *   cost → SPEC-085   runtime/owner → SPEC-086   health → SPEC-087
 * and the resolver/broker/gate (088–090) consume the assembled catalog.
 *
 * Deterministic: pure types + zod. No LLM, no network, no DB call (INV-01).
 */
import { z } from 'zod'
import { INTENT_CLASSES } from '@/agent/control-plane/admission/intent'

export const CAPABILITY_CONTRACT_VERSION = '1.0.0' as const

// ── Closed taxonomies ───────────────────────────────────────────────────────

export const CAPABILITY_STATUSES = ['active', 'preview', 'disabled'] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

/** Who may invoke — ordered most→least privileged; default is the most restrictive. */
export const CAPABILITY_SCOPES = ['owner', 'staff', 'customer'] as const
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number]

export const CAPABILITY_TIERS = ['light', 'standard', 'heavy'] as const
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number]

export const CAPABILITY_COST_CLASSES = ['free', 'metered', 'premium'] as const
export type CapabilityCostClass = (typeof CAPABILITY_COST_CLASSES)[number]

export const CAPABILITY_HEALTH_STATES = ['healthy', 'degraded', 'disabled'] as const
export type CapabilityHealthState = (typeof CAPABILITY_HEALTH_STATES)[number]

// ── Sub-schemas ─────────────────────────────────────────────────────────────

export const capabilityPermissionSchema = z.object({
  scope: z.enum(CAPABILITY_SCOPES),
  minRole: z.enum(CAPABILITY_SCOPES),
  /** Fail-closed default when no rule matches (SPEC-084 enforces it is 'deny'). */
  defaultDecision: z.literal('deny'),
})
export type CapabilityPermission = z.infer<typeof capabilityPermissionSchema>

export const capabilityCostSchema = z.object({
  tier: z.enum(CAPABILITY_TIERS),
  class: z.enum(CAPABILITY_COST_CLASSES),
})
export type CapabilityCost = z.infer<typeof capabilityCostSchema>

export const capabilityRuntimeSchema = z.object({
  groups: z.array(z.string().min(1)),
  pools: z.array(z.string().min(1)),
})
export type CapabilityRuntime = z.infer<typeof capabilityRuntimeSchema>

export const capabilityOwnerSchema = z.object({
  team: z.string().min(1),
  zonePrefix: z.string().min(1),
})
export type CapabilityOwner = z.infer<typeof capabilityOwnerSchema>

export const capabilityHealthSchema = z.object({
  status: z.enum(CAPABILITY_HEALTH_STATES),
  killSwitch: z.boolean(),
  reason: z.string().min(1).optional(),
})
export type CapabilityHealth = z.infer<typeof capabilityHealthSchema>

// ── Envelope ────────────────────────────────────────────────────────────────

export const capabilitySchema = z
  .object({
    /** Stable id, e.g. "cap.finance". */
    id: z.string().min(1).regex(/^cap\.[a-z][a-z0-9_]*$/, 'id must be cap.<snake_case>'),
    /** Domain key, e.g. "finance". */
    key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'snake_case key'),
    title: z.string().min(1),
    description: z.string().min(1),
    status: z.enum(CAPABILITY_STATUSES),
    /** Business-intent keys this capability serves (SPEC-082). */
    intents: z.array(z.string().min(1)).min(1),
    /** G02 admission intent classes this capability applies to (SPEC-082). */
    intentClasses: z.array(z.enum(INTENT_CLASSES)).min(1),
    /** G08 tool names that fulfil this capability (SPEC-083 validates existence). */
    toolNames: z.array(z.string().min(1)).min(1),
    permission: capabilityPermissionSchema,
    cost: capabilityCostSchema,
    runtime: capabilityRuntimeSchema,
    owner: capabilityOwnerSchema,
    health: capabilityHealthSchema,
  })
  .superRefine((c, ctx) => {
    if (c.id !== `cap.${c.key}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: `id '${c.id}' must equal cap.${c.key}` })
    }
    // A disabled capability must not present as healthy, and vice versa.
    if (c.status === 'disabled' && c.health.status !== 'disabled') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['health', 'status'], message: 'disabled capability must have health.status disabled' })
    }
    if (new Set(c.toolNames).size !== c.toolNames.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolNames'], message: 'duplicate tool names' })
    }
  })

export type Capability = z.infer<typeof capabilitySchema>

export function parseCapability(raw: unknown): Capability {
  return capabilitySchema.parse(raw)
}
export function safeParseCapability(raw: unknown) {
  return capabilitySchema.safeParse(raw)
}
