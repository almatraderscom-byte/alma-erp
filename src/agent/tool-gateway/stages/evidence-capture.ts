/**
 * G13 / SPEC-128 — Evidence capture stage.
 *
 * Realises INV-07 for the gateway: the FULL tool result is written to the G10
 * evidence store (authoritative, access-controlled), and the model receives ONLY
 * a bounded, sanitized, provenance-stamped view — never the raw blob. Policy
 * obligations carried from SPEC-124/126 (redact/mask) are applied to the payload
 * BEFORE bounding, so a redacted field can never survive into the model view even
 * if the payload is later truncated.
 *
 * Composition (all deterministic, INV-01):
 *   1. store full raw payload → evidenceId (G10 evidence store),
 *   2. apply obligations to the raw payload (G11 via SPEC-126 helper),
 *   3. bound + secret-redact the obligated payload (G08 boundedOutputView),
 *   4. stamp provenance (tool + evidenceId + identity + truncation) — G10 shape.
 *
 * Fail-closed: nothing to capture (no execution payload) ⇒ FAILED_FINAL.
 */
import { REASON_CODES } from '@/agent/contracts'
import { boundedOutputView } from '@/agent/tools/registry/io-schema'
import { evidenceStore, type EvidenceStore } from '@/agent/tools/results'
import type { Provenance } from '@/agent/tools/results'
import { advance, stop, type GatewayStage } from '../contract'
import { applyViewObligations } from './approval-obligation'

export const evidenceCaptureStage: GatewayStage = (ctx) => {
  // The execution stage must have produced a payload; if not, fail closed.
  if (!('rawPayload' in ctx)) return stop('FAILED_FINAL', [REASON_CODES.DEPENDENCY_FINAL])

  const store = (ctx.deps.evidenceStore as EvidenceStore | undefined) ?? evidenceStore
  const rec = store.put({
    toolName: ctx.toolName,
    payload: ctx.rawPayload,
    correlationId: ctx.identity.correlationId,
    observedAtMs: ctx.observedAtMs,
  })

  // Obligation-redact BEFORE bounding so a redacted field cannot leak via a preview.
  const obligated = applyViewObligations(ctx.rawPayload, ctx.obligations ?? [])
  const bounded = boundedOutputView(obligated)

  const provenance: Provenance = {
    toolName: ctx.toolName,
    evidenceId: rec.evidenceId,
    tenantId: ctx.identity.tenantId,
    correlationId: ctx.identity.correlationId,
    source: 'tool',
    observedAtMs: ctx.observedAtMs,
    truncated: bounded.truncated,
    contract: '1.0.0',
  }

  return advance(ctx, { evidenceId: rec.evidenceId, view: { provenance, view: bounded.view } })
}
