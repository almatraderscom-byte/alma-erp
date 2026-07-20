/**
 * G10 / SPEC-096 — Compact model-view contract.
 *
 * The firewall's front door: given a raw tool result, it (1) stores the FULL
 * payload as evidence (SPEC-095), and (2) returns the ONLY thing the model sees —
 * a bounded, secret-redacted view carrying the `evidenceId`. FAIL-CLOSED on size:
 * if the redacted view still exceeds the byte budget it is truncated and marked,
 * so the model can NEVER receive an unbounded or secret-bearing blob (INV-07).
 *
 * Deterministic, no LLM (INV-01).
 */
import {
  type ComponentResult,
  completed,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { evidenceStore, type EvidenceStore } from './evidence-store'

export const MODEL_VIEW_CONTRACT_VERSION = '1.0.0' as const

/** Default byte budget for a tool result handed to the model (4 KiB). */
export const MODEL_VIEW_BYTES = 4 * 1024

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|authorization|cookie|private[_-]?key|access[_-]?key|bearer)/i

export interface ModelView {
  evidenceId: string
  /** The bounded, redacted projection the model may see. */
  view: unknown
  truncated: boolean
  redactedKeys: string[]
  originalBytes: number
  viewBytes: number
}

function redact(value: unknown, redactedKeys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, redactedKeys))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]'
        redactedKeys.push(k)
      } else {
        out[k] = redact(v, redactedKeys)
      }
    }
    return out
  }
  return value
}

/**
 * Build the model view for a raw tool result. Stores full evidence and returns the
 * bounded, redacted view. `maxBytes` is clamped to [256, MODEL_VIEW_BYTES*8].
 */
export function buildModelView(
  input: { toolName: string; payload: unknown; correlationId: string; observedAtMs: number; maxBytes?: number },
  store: EvidenceStore = evidenceStore,
): ModelView {
  const rec = store.put({ toolName: input.toolName, payload: input.payload, correlationId: input.correlationId, observedAtMs: input.observedAtMs })
  const cap = Math.max(256, Math.min(input.maxBytes ?? MODEL_VIEW_BYTES, MODEL_VIEW_BYTES * 8))

  const redactedKeys: string[] = []
  const redacted = redact(input.payload, redactedKeys)
  const serialized = JSON.stringify(redacted ?? null)
  const originalBytes = rec.sizeBytes

  if (Buffer.byteLength(serialized, 'utf8') <= cap) {
    return { evidenceId: rec.evidenceId, view: redacted, truncated: false, redactedKeys, originalBytes, viewBytes: Buffer.byteLength(serialized, 'utf8') }
  }
  // Fail-closed: hand back a marked, byte-capped preview referencing evidence.
  // The FINAL serialized view (wrapper + JSON-escaped preview) must fit `cap`, so
  // trim the preview deterministically until the whole envelope is within budget.
  const note = `result exceeded ${cap} bytes; full payload in evidence ${rec.evidenceId}`
  const overhead = Buffer.byteLength(JSON.stringify({ _truncated: true, evidenceId: rec.evidenceId, preview: '', note }), 'utf8')
  let previewLen = Math.max(0, cap - overhead)
  let view: unknown = { _truncated: true, evidenceId: rec.evidenceId, preview: serialized.slice(0, previewLen), note }
  let viewBytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  while (viewBytes > cap && previewLen > 0) {
    previewLen = Math.max(0, Math.floor(previewLen * 0.9) - 1)
    view = { _truncated: true, evidenceId: rec.evidenceId, preview: serialized.slice(0, previewLen), note }
    viewBytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  }
  return { evidenceId: rec.evidenceId, view, truncated: true, redactedKeys, originalBytes, viewBytes }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const viewRequestSchema = z.object({
  toolName: z.string().min(1),
  payload: z.unknown(),
  observedAtMs: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive().optional(),
})

export function compactModelView(raw: unknown, store: EvidenceStore = evidenceStore): ComponentResult<ModelView> {
  const check = validateRequest(raw, viewRequestSchema, MODEL_VIEW_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const mv = buildModelView({ toolName: p.toolName, payload: p.payload, correlationId: check.request.identity.correlationId, observedAtMs: p.observedAtMs, maxBytes: p.maxBytes }, store)
  return completed(mv, [mv.evidenceId], { modelView: MODEL_VIEW_CONTRACT_VERSION })
}
