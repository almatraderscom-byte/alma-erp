/**
 * G09 / SPEC-090 — Capability certification gate.
 *
 * The whole-plane consistency gate. It composes every facet check from
 * SPEC-082..089 and certifies the capability control plane is internally coherent
 * and executable end-to-end. FAIL-CLOSED: `certified` is true only when EVERY
 * check passes with zero issues — one broken capability blocks the group.
 *
 * Checks:
 *   INTENT       every capability's intent/class surface is consistent (082)
 *   TOOLS        every capability tool exists; catalog partitions the 326 tools (083)
 *   PERMISSION   permission metadata valid, defaultDecision deny (084)
 *   COST         tier/class match the tools' real cost drivers (085)
 *   RUNTIME_OWN  runtime == tool routing; owner is a valid agent zone (086)
 *   HEALTH       health metadata consistent (087)
 *   BROKERABLE   every capability an owner can brokerage to a callable tool (088/089)
 *
 * Deterministic, no LLM (INV-01). Never certifies on a partial result.
 */
import {
  type ComponentResult,
  completed,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { capabilityStore } from './store'
import { checkAllIntentMappings } from './intent-map'
import { checkAllToolMappings, coverage } from './tool-map'
import { checkAllPermissionMetadata } from './permission'
import { checkAllCostMetadata } from './cost-tier'
import { checkAllRuntimeOwner } from './runtime-owner'
import { checkAllHealthMetadata } from './health'
import { broker } from './broker'

export const CERTIFICATION_CONTRACT_VERSION = '1.0.0' as const

export interface CertCheck {
  id: 'INTENT' | 'TOOLS' | 'COVERAGE' | 'PERMISSION' | 'COST' | 'RUNTIME_OWNER' | 'HEALTH' | 'BROKERABLE'
  description: string
  pass: boolean
  detail: string
}

export interface CertReport {
  certified: boolean
  checks: CertCheck[]
  blockers: CertCheck['id'][]
  summary: string
}

/** Every capability an owner can broker its own query intent to a callable tool. */
function brokerableIssues(): string[] {
  const bad: string[] = []
  for (const c of capabilityStore.list()) {
    const sel = broker({ intentKey: `query_${c.key}`, actor: { roles: ['owner'] } })
    if (!sel) bad.push(c.key)
  }
  return bad
}

export function evaluateCertification(): CertReport {
  const checks: CertCheck[] = []

  const intent = checkAllIntentMappings()
  checks.push({ id: 'INTENT', description: 'intent/class surfaces consistent', pass: intent.length === 0, detail: `${intent.length} issue(s)` })

  const tools = checkAllToolMappings()
  checks.push({ id: 'TOOLS', description: 'every capability tool exists, no duplicate routing', pass: tools.length === 0, detail: `${tools.length} issue(s)` })

  const cov = coverage()
  const covOk = cov.uncovered.length === 0 && cov.duplicated.length === 0 && cov.routedTools === cov.totalTools
  checks.push({ id: 'COVERAGE', description: 'catalog partitions the full tool surface', pass: covOk, detail: `${cov.routedTools}/${cov.totalTools} routed, ${cov.uncovered.length} uncovered` })

  const perm = checkAllPermissionMetadata()
  checks.push({ id: 'PERMISSION', description: 'permission metadata valid, fail-closed default', pass: perm.length === 0, detail: `${perm.length} issue(s)` })

  const cost = checkAllCostMetadata()
  checks.push({ id: 'COST', description: 'tier/class match tool cost drivers', pass: cost.length === 0, detail: `${cost.length} issue(s)` })

  const ro = checkAllRuntimeOwner()
  checks.push({ id: 'RUNTIME_OWNER', description: 'runtime == tool routing; owner valid agent zone', pass: ro.length === 0, detail: `${ro.length} issue(s)` })

  const health = checkAllHealthMetadata()
  checks.push({ id: 'HEALTH', description: 'health metadata consistent', pass: health.length === 0, detail: `${health.length} issue(s)` })

  const brokerBad = brokerableIssues()
  checks.push({ id: 'BROKERABLE', description: 'every capability brokers to a callable tool for its owner', pass: brokerBad.length === 0, detail: brokerBad.length ? `unbrokerable: ${brokerBad.slice(0, 3).join(',')}` : 'all brokerable' })

  const blockers = checks.filter((c) => !c.pass).map((c) => c.id)
  const certified = blockers.length === 0
  return {
    certified,
    checks,
    blockers,
    summary: certified
      ? `Capability control plane certified — ${capabilityStore.list().length} capabilities, all facets consistent and executable.`
      : `NOT certified — blockers: ${blockers.join(', ')}.`,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const certRequestSchema = z.object({ kind: z.literal('evaluate') })

export function queryCertificationGate(raw: unknown): ComponentResult<CertReport> {
  const check = validateRequest(raw, certRequestSchema, CERTIFICATION_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  return completed(evaluateCertification(), [], { certification: CERTIFICATION_CONTRACT_VERSION })
}
