/**
 * G13 / SPEC-122 — Schema validation stage.
 *
 * The first gateway stage: the model's tool arguments are validated against the
 * tool's registered schema BEFORE anything else runs. It reuses the G10 selection
 * argument validator (which itself fails closed on an unknown tool / unregistered
 * schema / oversized args). Fail-closed: unknown, oversized, or invalid arguments
 * DENY the whole gateway call — no later stage runs, no side effect happens.
 *
 * Deterministic (INV-01): Ajv over a frozen schema, no LLM/IO.
 */
import { validateToolArgs } from '@/agent/tools/selection/arg-validation'
import { advance, stop, type GatewayStage } from '../contract'
import { REASON_CODES } from '@/agent/contracts'

export const schemaValidationStage: GatewayStage = (ctx) => {
  const v = validateToolArgs(ctx.toolName, ctx.args)
  if (v.ok) return advance(ctx)
  const reason = v.code === 'oversized_args' ? REASON_CODES.OVERSIZED_INPUT : REASON_CODES.MALFORMED_INPUT
  return stop('DENIED', [reason])
}
