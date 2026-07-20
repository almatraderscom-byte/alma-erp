/**
 * G08 / SPEC-074 — Tool input/output schema registry.
 *
 * A deterministic store of per-tool IO schemas keyed by the manifest's
 * `io.inputSchemaId`, plus:
 *   - strict input validation (Ajv Draft-7) that rejects unknown root fields,
 *   - a bounded OUTPUT view (INV-07): the model receives a size-capped, secret-
 *     redacted projection while the full payload stays in evidence storage.
 *
 * Self-contained: this re-implements the strictening + validation locally rather
 * than importing the monolith's `tool-contract.ts`, so the decomposed registry
 * carries no dependency on the code it is meant to replace. No LLM (INV-01).
 */
import Ajv, { type ValidateFunction } from 'ajv'
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { IO_SCHEMAS } from './io-schemas.generated'

export const IO_CONTRACT_VERSION = '1.0.0' as const

export type JsonSchema = {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: unknown
  [k: string]: unknown
}

/**
 * Harden a schema for the strict contract: the ROOT object rejects unknown
 * fields. Nested objects keep whatever the author declared. Idempotent; returns
 * a new object.
 */
export function strictenSchema(schema: unknown): JsonSchema {
  const src = (schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} }) as JsonSchema
  const out: JsonSchema = { ...src }
  if (out.type === 'object' || out.properties !== undefined) {
    if (out.additionalProperties === undefined) out.additionalProperties = false
    if (out.properties === undefined) out.properties = {}
    if (out.type === undefined) out.type = 'object'
    if (out.required === undefined) out.required = []
  }
  return out
}

const ajv = new Ajv({ coerceTypes: 'array', useDefaults: true, strict: false, allErrors: true })
const validatorCache = new Map<string, ValidateFunction>()

export interface IoValidation {
  ok: boolean
  error?: string
}

/** Does the registry know this schema id? */
export function hasSchema(schemaId: string): boolean {
  return Object.prototype.hasOwnProperty.call(IO_SCHEMAS, schemaId)
}

export function getSchema(schemaId: string): JsonSchema | undefined {
  return hasSchema(schemaId) ? (IO_SCHEMAS[schemaId] as JsonSchema) : undefined
}

export function schemaIds(): string[] {
  return Object.keys(IO_SCHEMAS).sort()
}

export function schemaCount(): number {
  return Object.keys(IO_SCHEMAS).length
}

/**
 * Validate (and coerce, in place) an input against a registered schema. Unknown
 * schema ids fail CLOSED (INV-05) — the monolith fell open, but the decomposed
 * registry treats a missing schema as a hard error so a typo can't silently skip
 * validation.
 */
export function validateInput(schemaId: string, input: Record<string, unknown>): IoValidation {
  const schema = getSchema(schemaId)
  if (!schema) return { ok: false, error: `unknown schema id: ${schemaId}` }

  let validate = validatorCache.get(schemaId)
  if (!validate) {
    validate = ajv.compile(strictenSchema(schema) as object)
    validatorCache.set(schemaId, validate)
  }
  if (validate(input)) return { ok: true }

  const allowed = Object.keys((strictenSchema(schema).properties ?? {}) as Record<string, unknown>)
  const problems = (validate.errors ?? [])
    .map((e) => {
      if (e.keyword === 'additionalProperties') {
        return `unknown field "${(e.params as { additionalProperty?: string }).additionalProperty}"`
      }
      const path = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)'
      return `${path} ${e.message ?? 'is invalid'}`
    })
    .slice(0, 8)
  return { ok: false, error: `Invalid arguments: ${problems.join('; ')}. Allowed: ${allowed.join(', ') || '(none)'}.` }
}

// ── Bounded output view (INV-07) ────────────────────────────────────────────

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|authorization|cookie|private[_-]?key)/i

export interface BoundedView {
  /** The projection the model may see. */
  view: unknown
  /** True if the payload was truncated to fit the byte budget. */
  truncated: boolean
  /** Keys that were redacted for secret-safety. */
  redactedKeys: string[]
  /** Serialized size of the ORIGINAL payload (bytes). */
  originalBytes: number
}

/** Default output budget handed to a model (8 KiB). */
export const DEFAULT_VIEW_BYTES = 8 * 1024

/**
 * Produce a bounded, secret-redacted view of a tool OUTPUT for the model. The
 * full payload is the caller's responsibility to store in evidence (INV-07); the
 * model never receives secrets or an unbounded blob.
 */
export function boundedOutputView(payload: unknown, maxBytes = DEFAULT_VIEW_BYTES): BoundedView {
  const redactedKeys: string[] = []
  const redact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(redact)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) {
          out[k] = '[REDACTED]'
          redactedKeys.push(k)
        } else {
          out[k] = redact(val)
        }
      }
      return out
    }
    return v
  }
  const redacted = redact(payload)
  const serialized = JSON.stringify(redacted ?? null)
  const originalBytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8')
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return { view: redacted, truncated: false, redactedKeys, originalBytes }
  }
  // Truncate the serialized string and hand back a marked-up string view.
  const slice = serialized.slice(0, maxBytes)
  return {
    view: { _truncated: true, preview: slice, note: `output exceeded ${maxBytes} bytes; full payload in evidence` },
    truncated: true,
    redactedKeys,
    originalBytes,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const ioRequestSchema = z.union([
  z.object({ kind: z.literal('validateInput'), schemaId: z.string().min(1), input: z.record(z.unknown()) }),
  z.object({ kind: z.literal('hasSchema'), schemaId: z.string().min(1) }),
  z.object({ kind: z.literal('boundedView'), payload: z.unknown(), maxBytes: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('count') }),
])

export type IoRequest = z.infer<typeof ioRequestSchema>

export type IoResultValue =
  | { kind: 'validateInput'; ok: boolean; error?: string }
  | { kind: 'hasSchema'; present: boolean }
  | { kind: 'boundedView'; result: BoundedView }
  | { kind: 'count'; count: number }

export function validateToolIo(raw: unknown): ComponentResult<IoResultValue> {
  const check = validateRequest(raw, ioRequestSchema, IO_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { io: IO_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'validateInput': {
      const v = validateInput(q.schemaId, q.input)
      return completed({ kind: 'validateInput', ok: v.ok, error: v.error }, [], versions)
    }
    case 'hasSchema':
      return completed({ kind: 'hasSchema', present: hasSchema(q.schemaId) }, [], versions)
    case 'boundedView':
      return completed({ kind: 'boundedView', result: boundedOutputView(q.payload, q.maxBytes) }, [], versions)
    case 'count':
      return completed({ kind: 'count', count: schemaCount() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}

/** Test hook. */
export function clearIoValidatorCache(): void {
  validatorCache.clear()
}
