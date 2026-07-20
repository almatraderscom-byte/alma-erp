/**
 * G10 / SPEC-093 — Tool schema token minimization.
 *
 * Produces the token-lean tool definition the model actually receives: the root
 * description is capped, per-property descriptions are trimmed, and non-essential
 * JSON-Schema annotation keys (examples, $comment, title, default, …) are dropped
 * while the CONTRACT-bearing keys (type, properties, required, enum, items) are
 * preserved. Token counts use the shared G05 finops estimator (deterministic
 * heuristic — no model call, INV-01).
 *
 * Minimization never ADDS tokens: `tokensAfter <= tokensBefore` always.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { estimateTokens } from '@/agent/finops/tokens'
import { getManifest } from '@/agent/tools/manifests'
import { getSchema } from '@/agent/tools/registry/io-schema'

export const MINIMIZER_CONTRACT_VERSION = '1.0.0' as const

export const MAX_DESCRIPTION_CHARS = 200
export const MAX_PROP_DESCRIPTION_CHARS = 80

/** JSON-Schema keys whose value is a structural contract (must be kept). */
const KEEP_KEYS = new Set(['type', 'properties', 'required', 'enum', 'items', 'additionalProperties', 'anyOf', 'oneOf'])
/** Verbose annotation keys that are safe to drop for the model view. */
const DROP_KEYS = new Set(['examples', 'example', '$comment', 'title', 'default', 'readOnly', 'writeOnly', 'deprecated', '$schema', 'format', 'pattern'])

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

/** Recursively strip annotations + trim descriptions from a JSON schema. */
export function minimizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(minimizeSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue
    if (k === 'description' && typeof v === 'string') {
      out.description = trim(v, MAX_PROP_DESCRIPTION_CHARS)
    } else if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = minimizeSchema(pv)
      out.properties = props
    } else if (KEEP_KEYS.has(k) || typeof v !== 'string') {
      out[k] = minimizeSchema(v)
    } else {
      out[k] = v
    }
  }
  return out
}

export interface MinimizedTool {
  name: string
  description: string
  input_schema: unknown
  tokensBefore: number
  tokensAfter: number
}

/** Minimize one tool's model-facing definition. Unknown tools → null. */
export function minimizeToolSchema(name: string): MinimizedTool | null {
  const m = getManifest(name)
  if (!m) return null
  const rawSchema = getSchema(m.io.inputSchemaId) ?? { type: 'object', properties: {} }
  const before = JSON.stringify({ name, description: m.summary, input_schema: rawSchema })
  const description = trim(m.summary, MAX_DESCRIPTION_CHARS)
  const input_schema = minimizeSchema(rawSchema)
  const after = JSON.stringify({ name, description, input_schema })
  return {
    name,
    description,
    input_schema,
    tokensBefore: estimateTokens(before),
    tokensAfter: estimateTokens(after),
  }
}

export interface MinimizedShortlist {
  tools: MinimizedTool[]
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
}

export function minimizeShortlist(toolNames: readonly string[]): MinimizedShortlist {
  const tools = toolNames.map(minimizeToolSchema).filter((t): t is MinimizedTool => t !== null)
  const tokensBefore = tools.reduce((a, t) => a + t.tokensBefore, 0)
  const tokensAfter = tools.reduce((a, t) => a + t.tokensAfter, 0)
  return { tools, tokensBefore, tokensAfter, tokensSaved: Math.max(0, tokensBefore - tokensAfter) }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const minimizeRequestSchema = z.object({ toolNames: z.array(z.string().min(1)).min(1).max(64) })

export function minimizeToolSchemas(raw: unknown): ComponentResult<MinimizedShortlist> {
  const check = validateRequest(raw, minimizeRequestSchema, MINIMIZER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const result = minimizeShortlist(check.request.payload.toolNames)
  if (result.tools.length === 0) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  return completed(result, [], { minimizer: MINIMIZER_CONTRACT_VERSION })
}
