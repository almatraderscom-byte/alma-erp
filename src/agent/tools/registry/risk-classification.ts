/**
 * G08 / SPEC-075 — Tool risk and side-effect classification.
 *
 * Turns a manifest's declared `capability` (mode, risk, sideEffects) into the
 * deterministic POLICY HINTS the downstream architecture keys on:
 *   - requiresGateway        → every external side effect goes through the Tool
 *                              Gateway (INV-04)
 *   - requiresCostAuth       → every model call is pre-authorized by the Cost
 *                              Governor (INV-03)
 *   - requiresReconciliation → unknown external outcomes are reconciled, never
 *                              blindly retried (INV-06)
 *   - requiresApproval       → risky / effectful tools fail closed to approval
 *                              (INV-05)
 *
 * It also enforces consistency between `mode` and `sideEffects` so the manifest
 * set cannot drift into a nonsensical classification. Deterministic, no LLM
 * (INV-01): the classification of a request is arithmetic on frozen tables, not
 * a model judgement.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import {
  SIDE_EFFECT_KINDS,
  toolManifestSchema,
  type ManifestRisk,
  type SideEffectKind,
  type ToolManifest,
} from '../manifests/manifest.schema'

export const RISK_CONTRACT_VERSION = '1.0.0' as const

export interface SideEffectPolicy {
  /** Leaves the process boundary (provider / person / device / money rail). */
  external: boolean
  /** Must pass through the Secure Tool Gateway (INV-04). */
  requiresGateway: boolean
  /** Must be pre-authorized by the Cost Governor (INV-03). */
  requiresCostAuth: boolean
  /** Outcome can be unknown → reconciliation, never blind retry (INV-06). */
  requiresReconciliation: boolean
}

const P = (external: boolean, gateway: boolean, cost: boolean, recon: boolean): SideEffectPolicy => ({
  external,
  requiresGateway: gateway,
  requiresCostAuth: cost,
  requiresReconciliation: recon,
})

/** Frozen policy per side-effect kind. */
export const SIDE_EFFECT_POLICY: Record<SideEffectKind, SideEffectPolicy> = {
  none: P(false, false, false, false),
  db_read: P(false, false, false, false),
  db_write: P(false, false, false, false),
  external_message: P(true, true, false, true),
  external_api_write: P(true, true, false, true),
  money_movement: P(true, true, false, true),
  file_write: P(false, false, false, false),
  browser_action: P(true, true, false, true),
  model_invocation: P(true, false, true, false),
  schedule: P(false, false, false, false),
  push_notification: P(true, true, false, false),
}

const RISK_ORDER: Record<ManifestRisk, number> = { low: 0, medium: 1, high: 2 }
function maxRisk(a: ManifestRisk, b: ManifestRisk): ManifestRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

export interface RiskProfile {
  name: string
  /** Declared risk, raised to `high` if a money_movement effect is present. */
  effectiveRisk: ManifestRisk
  external: boolean
  requiresGateway: boolean
  requiresCostAuth: boolean
  requiresReconciliation: boolean
  /** Fail-closed approval requirement derived from mode + effective risk. */
  requiresApproval: boolean
  sideEffects: SideEffectKind[]
}

/**
 * Deterministically classify one manifest into its policy profile. Approval is
 * required for any staged tool, any non-low write, or any high-risk tool — the
 * fail-closed default (INV-05).
 */
export function classifyManifest(m: ToolManifest): RiskProfile {
  let external = false
  let requiresGateway = false
  let requiresCostAuth = false
  let requiresReconciliation = false
  let effectiveRisk: ManifestRisk = m.capability.risk
  for (const se of m.capability.sideEffects) {
    const pol = SIDE_EFFECT_POLICY[se]
    external ||= pol.external
    requiresGateway ||= pol.requiresGateway
    requiresCostAuth ||= pol.requiresCostAuth
    requiresReconciliation ||= pol.requiresReconciliation
    if (se === 'money_movement') effectiveRisk = maxRisk(effectiveRisk, 'high')
  }
  const mode = m.capability.mode
  const requiresApproval =
    mode === 'stage' || (mode === 'write' && effectiveRisk !== 'low') || effectiveRisk === 'high'
  return {
    name: m.name,
    effectiveRisk,
    external,
    requiresGateway,
    requiresCostAuth,
    requiresReconciliation,
    requiresApproval,
    sideEffects: m.capability.sideEffects,
  }
}

// ── Consistency enforcement ─────────────────────────────────────────────────

export interface ClassificationIssue {
  name: string
  code: 'READ_HAS_WRITE_EFFECT' | 'WRITE_HAS_NO_EFFECT' | 'MONEY_NOT_HIGH' | 'UNKNOWN_EFFECT'
  detail: string
}

const READ_SAFE: ReadonlySet<SideEffectKind> = new Set(['none', 'db_read'])

/**
 * Cross-check that a manifest's mode and side-effects are coherent:
 *  - a `read` tool may only carry read-safe effects,
 *  - a `write`/`stage` tool must carry at least one mutating effect,
 *  - a `money_movement` tool must be declared high risk,
 *  - every effect kind is in the frozen taxonomy.
 * Returns every issue (does not throw).
 */
export function checkClassification(m: ToolManifest): ClassificationIssue[] {
  const issues: ClassificationIssue[] = []
  for (const se of m.capability.sideEffects) {
    if (!(SIDE_EFFECT_KINDS as readonly string[]).includes(se)) {
      issues.push({ name: m.name, code: 'UNKNOWN_EFFECT', detail: se })
    }
  }
  if (m.capability.mode === 'read') {
    const bad = m.capability.sideEffects.filter((se) => !READ_SAFE.has(se))
    if (bad.length > 0) issues.push({ name: m.name, code: 'READ_HAS_WRITE_EFFECT', detail: bad.join(',') })
  } else {
    const hasMutating = m.capability.sideEffects.some((se) => !READ_SAFE.has(se))
    if (!hasMutating) issues.push({ name: m.name, code: 'WRITE_HAS_NO_EFFECT', detail: `${m.capability.mode} with only ${m.capability.sideEffects.join(',')}` })
  }
  if (m.capability.sideEffects.includes('money_movement') && m.capability.risk !== 'high') {
    issues.push({ name: m.name, code: 'MONEY_NOT_HIGH', detail: `risk=${m.capability.risk}` })
  }
  return issues
}

/** Classify a whole set, returning every consistency issue across it. */
export function checkAllClassifications(manifests: readonly ToolManifest[]): ClassificationIssue[] {
  return manifests.flatMap(checkClassification)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const riskRequestSchema = z.object({ manifest: z.unknown() })

export function classifyToolRisk(raw: unknown): ComponentResult<RiskProfile> {
  const check = validateRequest(raw, riskRequestSchema, RISK_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const parsed = toolManifestSchema.safeParse(check.request.payload.manifest)
  if (!parsed.success) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  const issues = checkClassification(parsed.data)
  if (issues.length > 0) {
    // Inconsistent classification is a hard, fail-closed error.
    return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
  return completed(classifyManifest(parsed.data), [], { risk: RISK_CONTRACT_VERSION })
}
