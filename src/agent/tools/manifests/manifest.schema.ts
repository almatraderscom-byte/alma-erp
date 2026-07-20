/**
 * G08 / SPEC-072 — Tool manifest schema.
 *
 * The frozen SHAPE of a decomposed tool manifest: one typed, runtime-validated
 * record describing everything the registry needs to know about a tool WITHOUT
 * importing the tool's handler (which drags prisma/network/models). Domain
 * packages (SPEC-073) author arrays of these; later specs deepen the *logic*
 * around individual facets:
 *   - io.inputSchemaId / outputSchemaId → SPEC-074 IO schema registry
 *   - capability.sideEffects            → SPEC-075 risk & side-effect classifier
 *   - ownership                         → SPEC-076 ownership metadata
 *   - version                           → SPEC-077 versioning
 *   - deprecation                       → SPEC-078 deprecation & migration
 *
 * Deterministic: pure types + zod. No I/O, no LLM (INV-01).
 */
import { z } from 'zod'
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'

export const MANIFEST_CONTRACT_VERSION = '1.0.0' as const

// ── Capability facet ────────────────────────────────────────────────────────

/** What the tool does when executed (mirrors the monolith CapabilityMode). */
export const MANIFEST_MODES = ['read', 'stage', 'write'] as const
export type ManifestMode = (typeof MANIFEST_MODES)[number]

/** Impact class: high = money / public / external people / master switches. */
export const MANIFEST_RISKS = ['low', 'medium', 'high'] as const
export type ManifestRisk = (typeof MANIFEST_RISKS)[number]

/**
 * Closed side-effect taxonomy. This is the SHAPE; SPEC-075 owns the classifier
 * that maps these to policy hints (approval / gateway / reconciliation) and the
 * consistency rules against `mode`. `none` is only valid alone.
 */
export const SIDE_EFFECT_KINDS = [
  'none',
  'db_read',
  'db_write',
  'external_message',
  'external_api_write',
  'money_movement',
  'file_write',
  'browser_action',
  'model_invocation',
  'schedule',
  'push_notification',
] as const
export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number]

// ── Lifecycle / version facet ───────────────────────────────────────────────

export const MANIFEST_STATUSES = ['active', 'preview', 'deprecated', 'removed'] as const
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number]

/** Strict semver `MAJOR.MINOR.PATCH` (no pre-release/build here; SPEC-077 parses). */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const semver = z.string().regex(SEMVER_RE, 'must be MAJOR.MINOR.PATCH semver')

// ── Sub-schemas ─────────────────────────────────────────────────────────────

export const capabilitySchema = z
  .object({
    mode: z.enum(MANIFEST_MODES),
    risk: z.enum(MANIFEST_RISKS),
    sideEffects: z.array(z.enum(SIDE_EFFECT_KINDS)).min(1),
  })
  .superRefine((c, ctx) => {
    if (c.sideEffects.includes('none') && c.sideEffects.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'none' cannot combine with other side effects" })
    }
    // Duplicates are a data smell — reject.
    if (new Set(c.sideEffects).size !== c.sideEffects.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate side-effect kinds' })
    }
  })
export type Capability = z.infer<typeof capabilitySchema>

export const ioSchema = z.object({
  /** Key into the IO schema registry (SPEC-074). */
  inputSchemaId: z.string().min(1),
  /** Optional output/result schema key. */
  outputSchemaId: z.string().min(1).optional(),
})
export type ManifestIo = z.infer<typeof ioSchema>

export const ownershipSchema = z.object({
  /** CODEOWNERS-style team handle (validated against G01 zones in SPEC-076). */
  team: z.string().min(1),
  /** Repo path prefix that owns this tool's implementation. */
  zonePrefix: z.string().min(1),
})
export type ManifestOwnership = z.infer<typeof ownershipSchema>

export const routingSchema = z.object({
  /** Head-facing TOOL_GROUPS advertising the tool (may be empty for mcp/customer). */
  groups: z.array(z.string().min(1)),
  /** Execution pools the tool is registered in. */
  pools: z.array(z.string().min(1)),
})
export type ManifestRouting = z.infer<typeof routingSchema>

export const deprecationSchema = z.object({
  /** Version at which the tool was deprecated. */
  since: semver,
  /** Replacement tool name (migration target), if any. */
  replacedBy: z.string().min(1).optional(),
  /** Version after which the tool may be removed (SPEC-078 enforces ordering). */
  removeAfter: semver.optional(),
  reason: z.string().min(1).optional(),
})
export type ManifestDeprecation = z.infer<typeof deprecationSchema>

// ── Manifest envelope ───────────────────────────────────────────────────────

export const toolManifestSchema = z
  .object({
    /** Stable tool name — the identifier a head calls. */
    name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'snake_case tool name'),
    /** Business domain (telemetry label + routing pack). */
    domain: z.string().min(1),
    /** Short human title. */
    title: z.string().min(1),
    /** Model-facing description. */
    summary: z.string().min(1),
    /** Semver of the tool's contract (SPEC-077). */
    version: semver,
    /** Lifecycle status. */
    status: z.enum(MANIFEST_STATUSES),
    capability: capabilitySchema,
    io: ioSchema,
    ownership: ownershipSchema,
    routing: routingSchema,
    deprecation: deprecationSchema.optional(),
  })
  .superRefine((m, ctx) => {
    // A deprecated/removed status must carry a deprecation record, and an active
    // one must not — the lifecycle and the record are kept consistent here so no
    // downstream consumer has to second-guess (SPEC-078 builds on this).
    const deprecatedStatus = m.status === 'deprecated' || m.status === 'removed'
    if (deprecatedStatus && !m.deprecation) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deprecation'], message: `status '${m.status}' requires a deprecation record` })
    }
    if (!deprecatedStatus && m.deprecation) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deprecation'], message: `status '${m.status}' must not carry a deprecation record` })
    }
    if (m.deprecation?.replacedBy === m.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deprecation', 'replacedBy'], message: 'a tool cannot be replaced by itself' })
    }
  })

export type ToolManifest = z.infer<typeof toolManifestSchema>

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isDeprecated(m: ToolManifest): boolean {
  return m.status === 'deprecated' || m.status === 'removed'
}

/** Parse-or-throw for authored data (used by domain packages at load). */
export function parseManifest(raw: unknown): ToolManifest {
  return toolManifestSchema.parse(raw)
}

/** Safe parse returning zod's typed result (no throw). */
export function safeParseManifest(raw: unknown) {
  return toolManifestSchema.safeParse(raw)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

/**
 * Validate an untrusted manifest through the G01 boundary. Enforces the full
 * ExecutionIdentity (INV-02) and returns the frozen discriminated union — never
 * a throw, never an ambiguous boolean. On a malformed manifest it returns
 * `FAILED_FINAL` with `MALFORMED_INPUT` (fail-closed, INV-05).
 */
export function validateManifest(raw: unknown): ComponentResult<ToolManifest> {
  const check = validateRequest(raw, z.object({ manifest: z.unknown() }), MANIFEST_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const parsed = toolManifestSchema.safeParse(check.request.payload.manifest)
  if (!parsed.success) {
    return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
  return completed(parsed.data, [], { manifest: MANIFEST_CONTRACT_VERSION })
}
