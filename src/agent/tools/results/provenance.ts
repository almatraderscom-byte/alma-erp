/**
 * G10 / SPEC-099 — Tool result provenance.
 *
 * Every result the model sees must be TRACEABLE: which tool produced it, which
 * evidence record holds the full payload, which request (tenant + correlation) it
 * belongs to, its source kind, and whether it was truncated. This stamps the
 * compact model view (SPEC-096) with that provenance envelope, and provides a
 * fail-closed completeness check so an un-provenanced result can be rejected.
 *
 * Deterministic, no LLM (INV-01). Timestamps are caller-supplied.
 */
import {
  type ComponentResult,
  type ExecutionIdentity,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { buildModelView, MODEL_VIEW_CONTRACT_VERSION, type ModelView } from './model-view'
import { evidenceStore, type EvidenceStore } from './evidence-store'

export const PROVENANCE_CONTRACT_VERSION = '1.0.0' as const

export const RESULT_SOURCES = ['tool', 'search', 'browser', 'summary'] as const
export type ResultSource = (typeof RESULT_SOURCES)[number]

export interface Provenance {
  toolName: string
  evidenceId: string
  tenantId: string
  correlationId: string
  source: ResultSource
  observedAtMs: number
  truncated: boolean
  contract: string
}

export interface ProvenancedView {
  provenance: Provenance
  view: unknown
}

/** Compose a bounded model view (SPEC-096) with a provenance envelope. */
export function buildProvenancedView(
  input: { toolName: string; payload: unknown; identity: ExecutionIdentity; source: ResultSource; observedAtMs: number; maxBytes?: number },
  store: EvidenceStore = evidenceStore,
): ProvenancedView {
  const mv: ModelView = buildModelView(
    { toolName: input.toolName, payload: input.payload, correlationId: input.identity.correlationId, observedAtMs: input.observedAtMs, maxBytes: input.maxBytes },
    store,
  )
  const provenance: Provenance = {
    toolName: input.toolName,
    evidenceId: mv.evidenceId,
    tenantId: input.identity.tenantId,
    correlationId: input.identity.correlationId,
    source: input.source,
    observedAtMs: input.observedAtMs,
    truncated: mv.truncated,
    contract: `${PROVENANCE_CONTRACT_VERSION}/${MODEL_VIEW_CONTRACT_VERSION}`,
  }
  return { provenance, view: mv.view }
}

export interface ProvenanceIssue {
  code: 'MISSING_TOOL' | 'MISSING_EVIDENCE' | 'MISSING_TENANT' | 'MISSING_CORRELATION' | 'BAD_SOURCE'
  detail: string
}

/** Fail-closed completeness check: is this provenance fully traceable? */
export function checkProvenance(p: Partial<Provenance> | null | undefined): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = []
  if (!p) return [{ code: 'MISSING_TOOL', detail: 'no provenance' }]
  if (!p.toolName) issues.push({ code: 'MISSING_TOOL', detail: 'toolName' })
  if (!p.evidenceId) issues.push({ code: 'MISSING_EVIDENCE', detail: 'evidenceId' })
  if (!p.tenantId) issues.push({ code: 'MISSING_TENANT', detail: 'tenantId' })
  if (!p.correlationId) issues.push({ code: 'MISSING_CORRELATION', detail: 'correlationId' })
  if (!p.source || !(RESULT_SOURCES as readonly string[]).includes(p.source)) issues.push({ code: 'BAD_SOURCE', detail: String(p.source) })
  return issues
}

export function isTraceable(p: Partial<Provenance> | null | undefined): boolean {
  return checkProvenance(p).length === 0
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const provenanceRequestSchema = z.object({
  toolName: z.string().min(1),
  payload: z.unknown(),
  source: z.enum(RESULT_SOURCES),
  observedAtMs: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive().optional(),
})

export function provenancedResult(raw: unknown, store: EvidenceStore = evidenceStore): ComponentResult<ProvenancedView> {
  const check = validateRequest(raw, provenanceRequestSchema, PROVENANCE_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const pv = buildProvenancedView({ toolName: p.toolName, payload: p.payload, identity: check.request.identity, source: p.source, observedAtMs: p.observedAtMs, maxBytes: p.maxBytes }, store)
  // Fail-closed: never emit an un-traceable result.
  if (!isTraceable(pv.provenance)) return failure('FAILED_FINAL', [REASON_CODES.UNKNOWN_OUTCOME])
  return completed(pv, [pv.provenance.evidenceId], { provenance: PROVENANCE_CONTRACT_VERSION })
}
