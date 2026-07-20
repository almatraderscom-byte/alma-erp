/**
 * G08 / SPEC-080 — Monolithic registry removal gate.
 *
 * The gate that certifies whether the monolith (`src/agent/tools/registry.ts`)
 * may be removed. It NEVER deletes anything — deleting live production is out of
 * scope and out of the owned zone (INV-09: existing public behaviour stays until
 * migration evidence passes). It is a deterministic, fail-CLOSED precondition
 * check: `canRemove` is true only when EVERY precondition holds, including the
 * operational cutover, which defaults to NOT done.
 *
 * Preconditions checked:
 *   - PARITY        new registry ≡ SPEC-071 inventory (no tool lost/added)
 *   - SCHEMA        every domain package + manifest valid, names globally unique
 *   - CLASSIFY      every manifest classification-consistent (SPEC-075)
 *   - OWNERSHIP     every manifest bound to a valid agent zone (SPEC-076)
 *   - DEPRECATION   deprecation records intact, no migration cycles (SPEC-078)
 *   - IO            every manifest's inputSchemaId resolves (SPEC-074)
 *   - BUILDABLE     the enforce-mode registry builds and every entry is callable
 *   - CUTOVER       the runtime has been switched to enforce with owner sign-off
 *                   (operational; supplied by the caller, defaults false)
 *
 * No LLM, no I/O (INV-01).
 */
import {
  type ComponentResult,
  completed,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { ALL_MANIFESTS, ALL_PACKAGES, validateAll } from '../manifests/loader'
import { checkAllClassifications } from './risk-classification'
import { checkAllOwnership } from './ownership-metadata'
import { checkAllDeprecations } from './deprecation'
import { hasSchema } from './io-schema'
import { buildRuntimeRegistry, shadowCompare } from './runtime-registry'

export const REMOVAL_GATE_CONTRACT_VERSION = '1.0.0' as const

export interface RemovalCheck {
  id: 'PARITY' | 'SCHEMA' | 'CLASSIFY' | 'OWNERSHIP' | 'DEPRECATION' | 'IO' | 'BUILDABLE' | 'CUTOVER'
  description: string
  pass: boolean
  detail: string
}

export interface GateReport {
  /** True only when EVERY check passes (fail-closed). */
  canRemove: boolean
  checks: RemovalCheck[]
  blockers: RemovalCheck['id'][]
  summary: string
}

export interface GateOptions {
  /**
   * Has the live core loop been switched to the enforce-mode registry with owner
   * sign-off? Defaults FALSE — the gate must not green-light removal while the
   * monolith is still authoritative (INV-09).
   */
  enforceCutoverDone?: boolean
}

/** Deterministically evaluate the removal gate. */
export function evaluateRemovalGate(opts: GateOptions = {}): GateReport {
  const checks: RemovalCheck[] = []

  const parity = shadowCompare()
  checks.push({
    id: 'PARITY',
    description: 'new registry matches the SPEC-071 monolith inventory',
    pass: parity.parity,
    detail: parity.parity ? `${parity.matched} tools matched, 0 drift` : `onlyInNew=${parity.onlyInNew.length}, onlyInInventory=${parity.onlyInInventory.length}`,
  })

  const schemaIssues = validateAll(ALL_PACKAGES)
  checks.push({ id: 'SCHEMA', description: 'all domain packages + manifests valid, names unique', pass: schemaIssues.length === 0, detail: `${schemaIssues.length} issue(s)` })

  const classifyIssues = checkAllClassifications(ALL_MANIFESTS)
  checks.push({ id: 'CLASSIFY', description: 'every manifest classification-consistent', pass: classifyIssues.length === 0, detail: `${classifyIssues.length} issue(s)` })

  const ownIssues = checkAllOwnership(ALL_MANIFESTS)
  checks.push({ id: 'OWNERSHIP', description: 'every manifest bound to a valid agent zone', pass: ownIssues.length === 0, detail: `${ownIssues.length} issue(s)` })

  const depIssues = checkAllDeprecations(ALL_MANIFESTS)
  checks.push({ id: 'DEPRECATION', description: 'deprecation records intact, no cycles', pass: depIssues.length === 0, detail: `${depIssues.length} issue(s)` })

  const missingSchemas = ALL_MANIFESTS.filter((m) => !hasSchema(m.io.inputSchemaId)).map((m) => m.name)
  checks.push({ id: 'IO', description: "every manifest's inputSchemaId resolves", pass: missingSchemas.length === 0, detail: missingSchemas.length ? `missing: ${missingSchemas.slice(0, 3).join(',')}` : 'all resolve' })

  const enforced = buildRuntimeRegistry('enforce')
  const buildable = enforced.toolCount > 0 && enforced.toolCount === enforced.callableCount
  checks.push({ id: 'BUILDABLE', description: 'enforce-mode registry builds, all entries callable', pass: buildable, detail: `${enforced.toolCount} tools, ${enforced.callableCount} callable` })

  const cutover = opts.enforceCutoverDone === true
  checks.push({ id: 'CUTOVER', description: 'runtime switched to enforce with owner sign-off', pass: cutover, detail: cutover ? 'done' : 'NOT done — monolith still authoritative (INV-09)' })

  const blockers = checks.filter((c) => !c.pass).map((c) => c.id)
  const canRemove = blockers.length === 0
  return {
    canRemove,
    checks,
    blockers,
    summary: canRemove
      ? 'ALL preconditions met — monolith registry.ts is safe to remove.'
      : `BLOCKED — ${blockers.join(', ')} must pass before removal.`,
  }
}

/**
 * The proposed (NOT applied) removal steps. Documented here so the operational
 * step is explicit; execution is the integration session's, never a group
 * session's, and never inside this gate.
 */
export const PROPOSED_REMOVAL_PLAN = [
  '1. Wire the core loop to buildRuntimeRegistry("enforce") behind the feature flag.',
  '2. Run in shadow → warn → enforce, watching the shadow comparison stay at parity.',
  '3. With owner sign-off, set enforceCutoverDone and re-run this gate → canRemove.',
  '4. Delete src/agent/tools/registry.ts + fold callers onto the new registry.',
  '5. Keep the git revert as the rollback (feature flag → rollback covers runtime).',
] as const

// ── Identity-enforced boundary ──────────────────────────────────────────────

const gateRequestSchema = z.object({
  kind: z.literal('evaluate'),
  enforceCutoverDone: z.boolean().optional(),
})

export function queryRemovalGate(raw: unknown): ComponentResult<GateReport> {
  const check = validateRequest(raw, gateRequestSchema, REMOVAL_GATE_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const report = evaluateRemovalGate({ enforceCutoverDone: check.request.payload.enforceCutoverDone })
  return completed(report, [], { removalGate: REMOVAL_GATE_CONTRACT_VERSION })
}
