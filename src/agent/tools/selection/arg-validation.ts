/**
 * G10 / SPEC-094 — Tool argument validation.
 *
 * The last selection-side gate before a tool runs: validate the model's arguments
 * against the tool's registered schema. FAIL-CLOSED — an unknown tool, an
 * unregistered schema, oversized arguments, or a schema violation all DENY, so a
 * handler never runs on unvalidated input. Reuses the G08 IO schema registry
 * (which itself fails closed on an unknown schema id).
 *
 * Deterministic, no LLM (INV-01): validation is Ajv over a frozen schema.
 */
import {
  type ComponentResult,
  REASON_CODES,
  allowed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { getManifest } from '@/agent/tools/manifests'
import { validateInput } from '@/agent/tools/registry/io-schema'

export const ARG_VALIDATION_CONTRACT_VERSION = '1.0.0' as const

/** Hard bound on serialized argument size (64 KiB) — over this DENIES pre-parse. */
export const MAX_ARG_BYTES = 64 * 1024

export type ArgValidationCode = 'unknown_tool' | 'oversized_args' | 'invalid_args' | 'ok'

export interface ArgValidation {
  ok: boolean
  code: ArgValidationCode
  error?: string
}

/**
 * Validate `args` for `toolName`. Fail-closed on every uncertainty. Returns a
 * typed verdict (never throws).
 */
export function validateToolArgs(toolName: string, args: Record<string, unknown>): ArgValidation {
  const m = getManifest(toolName)
  if (!m) return { ok: false, code: 'unknown_tool', error: `unknown tool: ${toolName}` }

  const size = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8')
  if (size > MAX_ARG_BYTES) return { ok: false, code: 'oversized_args', error: `arguments exceed ${MAX_ARG_BYTES} bytes` }

  const v = validateInput(m.io.inputSchemaId, args)
  if (!v.ok) return { ok: false, code: 'invalid_args', error: v.error }
  return { ok: true, code: 'ok' }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const argRequestSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()),
})

/**
 * Admit (or reject) a tool call by its arguments. Returns ALLOWED only when the
 * tool exists and its args validate; DENIED otherwise (fail-closed, INV-05).
 */
export function admitToolCall(raw: unknown): ComponentResult<{ toolName: string }> {
  const check = validateRequest(raw, argRequestSchema, ARG_VALIDATION_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const { toolName, args } = check.request.payload
  const v = validateToolArgs(toolName, args as Record<string, unknown>)
  if (v.ok) return allowed({ toolName }, [], { argValidation: ARG_VALIDATION_CONTRACT_VERSION })
  const reason = v.code === 'oversized_args' ? REASON_CODES.OVERSIZED_INPUT : REASON_CODES.MALFORMED_INPUT
  return failure('DENIED', [reason])
}
