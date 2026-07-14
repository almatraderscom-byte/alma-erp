/**
 * Tool Contract V2 (roadmap Phase 2) — the single place that defines WHAT a tool
 * promises: its capability classification, its strict input contract, and the
 * stable machine-readable result envelope.
 *
 * Layering (no import cycles):
 *   tool-contract.ts            ← types + validation + error codes (this file, leaf)
 *   capability-classification.ts← authored per-tool classification data
 *   registry.ts / cs-registry.ts← executors call validateToolInput() before handlers
 *   capability-manifest.ts      ← joins pools + groups + classification for tests/router
 */
import Ajv, { type ValidateFunction } from 'ajv'

// ── Capability classification ────────────────────────────────────────────────

/** What the tool DOES when executed. */
export type CapabilityMode =
  /** Pure read — no state change beyond telemetry. */
  | 'read'
  /** Stages a pending approval card / draft / proposal; effect happens only after the owner approves. */
  | 'stage'
  /** Direct effect (DB write, message, call, browser action) without a later owner gate. */
  | 'write'

export type CapabilityRisk = 'low' | 'medium' | 'high'

/** How owner approval is achieved for this capability. */
export type CapabilityApproval =
  /** No approval needed (reads, internal bookkeeping). */
  | 'none'
  /** The tool itself stages an owner approval card — approval happens at card-execute time. */
  | 'staged_card'
  /** Executor must require approval BEFORE running the handler (enforced in a later phase). */
  | 'before_execute'

export type CapabilityConcurrency = 'parallel_read' | 'sequential'
export type CapabilityIdempotency = 'required' | 'optional'
export type CapabilityProof = 'none' | 'record' | 'external'

/**
 * How the head reaches this tool.
 *  - 'group': via TOOL_GROUPS routing (the normal owner-head path).
 *  - 'mcp': exposed only on the external MCP co-worker connector, never a head group.
 *  - 'customer': CS-1 customer surface only (cs-registry), never a head group.
 */
export type CapabilityRouting = 'group' | 'mcp' | 'customer'

/** Authored per-tool classification (capability-classification.ts). */
export interface ToolClassification {
  domain: string
  mode: CapabilityMode
  risk: CapabilityRisk
  /** Default derived from mode (see classificationDefaults) unless overridden. */
  approval?: CapabilityApproval
  concurrency?: CapabilityConcurrency
  idempotency?: CapabilityIdempotency
  proof?: CapabilityProof
  routing?: CapabilityRouting
}

/** Classification with all defaults resolved. */
export interface ResolvedClassification extends Required<ToolClassification> {}

/**
 * Mode-derived defaults: reads are safely parallel and proof-free; staged tools
 * must not double-stage cards (the multi-card incident class) and their proof is
 * the pending-action record; writes are sequential and must leave a record.
 */
export function resolveClassification(c: ToolClassification): ResolvedClassification {
  const byMode: Record<CapabilityMode, Pick<ResolvedClassification, 'approval' | 'concurrency' | 'idempotency' | 'proof'>> = {
    read: { approval: 'none', concurrency: 'parallel_read', idempotency: 'optional', proof: 'none' },
    stage: { approval: 'staged_card', concurrency: 'sequential', idempotency: 'required', proof: 'record' },
    write: { approval: 'none', concurrency: 'sequential', idempotency: 'required', proof: 'record' },
  }
  const d = byMode[c.mode]
  return {
    domain: c.domain,
    mode: c.mode,
    risk: c.risk,
    approval: c.approval ?? d.approval,
    concurrency: c.concurrency ?? d.concurrency,
    idempotency: c.idempotency ?? d.idempotency,
    proof: c.proof ?? d.proof,
    routing: c.routing ?? 'group',
  }
}

// ── Stable error codes + retry policy ────────────────────────────────────────

/**
 * Stable machine error codes. Dashboards, retry policy, and the head's own
 * "should I try again?" decision key on these — never on free-form error text.
 */
export const TOOL_ERROR_CODES = [
  'invalid_args', // rejected by central schema validation — handler never ran
  'unknown_tool',
  'wrong_business',
  'not_found',
  'auth',
  'timeout',
  'rate_limited',
  'network',
  'bad_args', // handler-detected argument problem (legacy free-form match)
  'db',
  'provider_5xx',
  'uncaught_exception',
  'handler_error',
  'unknown',
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** Transient failures where the SAME call may succeed if simply retried. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['timeout', 'rate_limited', 'network', 'provider_5xx'])

export function isRetryableErrorCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_CODES.has(code)
}

/**
 * Phase 1 stable error codes, derived from a handler's free-form error string.
 * Coarse but MACHINE-STABLE: dashboards and retry policy group on these while
 * handlers migrate to declaring `errorCode` themselves (result envelope).
 */
export function classifyErrorCode(error: string | undefined): string {
  const e = (error ?? '').toLowerCase()
  if (!e) return 'unknown'
  if (/(not\s*found|missing|no such|খুঁজে পাইনি|পাওয়া যায়নি)/.test(e)) return 'not_found'
  if (/(unauthorized|forbidden|permission|401|403|api.?key)/.test(e)) return 'auth'
  if (/(timeout|timed out|etimedout|deadline)/.test(e)) return 'timeout'
  if (/(rate.?limit|429|too many requests|quota)/.test(e)) return 'rate_limited'
  if (/(econnrefused|econnreset|enotfound|network|fetch failed|socket)/.test(e)) return 'network'
  if (/(invalid|validation|required|must be|expected|malformed)/.test(e)) return 'bad_args'
  if (/(prisma|database|column|relation|constraint|sql)/.test(e)) return 'db'
  if (/(5\d\d|internal server|upstream|provider)/.test(e)) return 'provider_5xx'
  return 'handler_error'
}

// ── Strict input schemas ─────────────────────────────────────────────────────

type JsonSchemaObject = {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: unknown
  [k: string]: unknown
}

/**
 * Harden a tool input schema for the strict contract: the ROOT object rejects
 * unknown fields (`additionalProperties: false`). Nested objects keep whatever
 * the author declared — free-form `metadata`-style params stay permissive on
 * purpose. Idempotent; returns a new object (does not mutate the input).
 */
export function strictenSchema(schema: unknown): JsonSchemaObject {
  const src = (schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} }) as JsonSchemaObject
  const out: JsonSchemaObject = { ...src }
  if (out.type === 'object' || out.properties !== undefined) {
    if (out.additionalProperties === undefined) out.additionalProperties = false
    if (out.properties === undefined) out.properties = {}
    if (out.type === undefined) out.type = 'object'
    // Explicit empty `required` when absent: all-optional is a DECLARED contract,
    // not an accident of a missing key (Phase 2 audit: 86 required-less schemas).
    if (out.required === undefined) out.required = []
  }
  return out
}

// ── Central runtime validation (Ajv, Draft-7) ────────────────────────────────

/**
 * One shared Ajv instance.
 *  - coerceTypes:'array' — REQUIRED: the Gemini adapter round-trips numeric enums
 *    as strings (see adapters/gemini-schema.ts), and models emit "5" for 5; scalar
 *    ↔ single-element-array mismatches are also coerced instead of rejected.
 *  - useDefaults — schema-declared defaults are filled in.
 *  - strict:false — existing schemas carry advisory keywords Ajv strict mode
 *    would refuse to compile.
 *  - allErrors — the model gets EVERY problem in one shot so it can fix its call
 *    in a single retry instead of peeling one error per round.
 */
const ajv = new Ajv({ coerceTypes: 'array', useDefaults: true, strict: false, allErrors: true })

const validatorCache = new Map<string, ValidateFunction>()

export interface ToolInputValidation {
  ok: boolean
  /** Model-facing, actionable message (English — the head translates for the owner). */
  error?: string
}

/**
 * Validate (and coerce, in place) model-generated arguments against a tool's
 * strict schema BEFORE the handler runs. `cacheKey` should be the tool name —
 * compiled validators are reused across calls (compilation is expensive).
 *
 * Never throws: a schema that fails to compile is reported as ok (fail-open for
 * the tool, fail-loud in CI — the manifest test compiles every schema).
 */
export function validateToolInput(
  cacheKey: string,
  schema: unknown,
  input: Record<string, unknown>,
): ToolInputValidation {
  let validate = validatorCache.get(cacheKey)
  if (!validate) {
    try {
      validate = ajv.compile(strictenSchema(schema) as object)
    } catch {
      return { ok: true } // CI guards compilability; runtime never blocks on a broken schema
    }
    validatorCache.set(cacheKey, validate)
  }

  if (validate(input)) return { ok: true }

  const allowed = Object.keys((strictenSchema(schema).properties ?? {}) as Record<string, unknown>)
  const problems = (validate.errors ?? [])
    .map((e) => {
      if (e.keyword === 'additionalProperties') {
        const extra = (e.params as { additionalProperty?: string }).additionalProperty
        return `unknown field "${extra}"`
      }
      const path = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)'
      return `${path} ${e.message ?? 'is invalid'}`
    })
    .slice(0, 8)
  return {
    ok: false,
    error:
      `Invalid arguments: ${problems.join('; ')}. ` +
      `Allowed fields: ${allowed.length > 0 ? allowed.join(', ') : '(none — call with {})'}. ` +
      'Fix the arguments and call the tool again.',
  }
}

/** Test hook — compiled validators are keyed by tool name and cached for reuse. */
export function clearValidatorCache(): void {
  validatorCache.clear()
}
