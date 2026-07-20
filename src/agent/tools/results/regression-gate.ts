/**
 * G10 / SPEC-100 — Tool-selection and result-size regression gate.
 *
 * The whole-firewall gate. It exercises the selection side (shortlist bound,
 * schema minimization, fail-closed arg validation) AND the result side (evidence
 * stored, model view byte-bounded, secret redaction, provenance traceable,
 * normalization bounded) on sample inputs, and certifies every firewall invariant
 * holds. FAIL-CLOSED: `certified` is true only when EVERY check passes — one leak
 * or unbounded path blocks the group.
 *
 * Deterministic, no LLM (INV-01). Timestamps are caller-supplied.
 */
import {
  type ComponentResult,
  completed,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { MAX_SHORTLIST, selectShortlist } from '@/agent/tools/selection'
import { minimizeShortlist } from '@/agent/tools/selection'
import { validateToolArgs } from '@/agent/tools/selection'
import { InMemoryEvidenceStore } from './evidence-store'
import { buildModelView, MODEL_VIEW_BYTES } from './model-view'
import { normalizeSearchResults, MAX_ITEMS } from './normalize'
import { buildProvenancedView, isTraceable } from './provenance'
import { ALL_MANIFESTS } from '@/agent/tools/manifests'

export const FIREWALL_GATE_CONTRACT_VERSION = '1.0.0' as const

export interface FirewallCheck {
  id:
    | 'SHORTLIST_BOUND'
    | 'SCHEMA_MINIMIZED'
    | 'ARG_FAILCLOSED'
    | 'EVIDENCE_STORED'
    | 'VIEW_BOUNDED'
    | 'SECRET_REDACTED'
    | 'PROVENANCE_TRACEABLE'
    | 'NORMALIZE_BOUNDED'
  description: string
  pass: boolean
  detail: string
}

export interface FirewallReport {
  certified: boolean
  checks: FirewallCheck[]
  blockers: FirewallCheck['id'][]
  summary: string
}

export function evaluateFirewallGate(observedAtMs = 0): FirewallReport {
  const checks: FirewallCheck[] = []
  const store = new InMemoryEvidenceStore()

  // Selection: shortlist never exceeds the hard cap.
  const bigCandidates = ALL_MANIFESTS.map((m) => m.name)
  const sl = selectShortlist(bigCandidates, 9999)
  checks.push({ id: 'SHORTLIST_BOUND', description: 'shortlist ≤ MAX_SHORTLIST', pass: sl.toolNames.length <= MAX_SHORTLIST, detail: `${sl.toolNames.length}/${MAX_SHORTLIST}` })

  // Selection: schema minimization never adds tokens.
  const mini = minimizeShortlist(ALL_MANIFESTS.slice(0, 20).map((m) => m.name))
  checks.push({ id: 'SCHEMA_MINIMIZED', description: 'minimized tokens ≤ raw tokens', pass: mini.tokensAfter <= mini.tokensBefore, detail: `${mini.tokensAfter} ≤ ${mini.tokensBefore}` })

  // Selection: arg validation fails closed on unknown tool + invalid args.
  const argClosed = validateToolArgs('__ghost__', {}).ok === false && validateToolArgs('save_memory', { scope: 'personal' }).ok === false
  checks.push({ id: 'ARG_FAILCLOSED', description: 'unknown tool + invalid args rejected', pass: argClosed, detail: String(argClosed) })

  // Result: evidence stored; view byte-bounded; secret redacted.
  const big = { api_key: 'sk-SECRET', rows: Array.from({ length: 5000 }, (_, i) => ({ i, note: 'x'.repeat(50) })) }
  const mv = buildModelView({ toolName: 't', payload: big, correlationId: 'c', observedAtMs }, store)
  checks.push({ id: 'EVIDENCE_STORED', description: 'full payload stored as evidence', pass: store.has(mv.evidenceId), detail: mv.evidenceId })
  checks.push({ id: 'VIEW_BOUNDED', description: 'model view within byte budget', pass: mv.viewBytes <= MODEL_VIEW_BYTES, detail: `${mv.viewBytes} bytes ≤ ${MODEL_VIEW_BYTES}` })
  const viewStr = JSON.stringify(mv.view)
  checks.push({ id: 'SECRET_REDACTED', description: 'secret never in the model view', pass: !viewStr.includes('sk-SECRET'), detail: viewStr.includes('sk-SECRET') ? 'LEAK' : 'clean' })

  // Result: provenance traceable.
  const pv = buildProvenancedView({ toolName: 'search_web', payload: { title: 'x' }, identity: { tenantId: 'alma', actorId: 'o', workflowId: 'w', stepId: 's', correlationId: 'c' }, source: 'search', observedAtMs }, store)
  checks.push({ id: 'PROVENANCE_TRACEABLE', description: 'result carries traceable provenance', pass: isTraceable(pv.provenance), detail: pv.provenance.evidenceId })

  // Result: normalization bounded.
  const norm = normalizeSearchResults({ results: Array.from({ length: 200 }, (_, i) => ({ title: 't' + i, link: 'https://x' + i + '.com' })) }, 9999)
  checks.push({ id: 'NORMALIZE_BOUNDED', description: 'normalized items ≤ MAX_ITEMS', pass: norm.items.length <= MAX_ITEMS, detail: `${norm.items.length}/${MAX_ITEMS}` })

  const blockers = checks.filter((c) => !c.pass).map((c) => c.id)
  const certified = blockers.length === 0
  return {
    certified,
    checks,
    blockers,
    summary: certified
      ? 'Tool-selection + result firewall certified — all bounds hold and no secret leaks the model view.'
      : `NOT certified — blockers: ${blockers.join(', ')}.`,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const gateRequestSchema = z.object({ kind: z.literal('evaluate'), observedAtMs: z.number().int().nonnegative().optional() })

export function queryFirewallGate(raw: unknown): ComponentResult<FirewallReport> {
  const check = validateRequest(raw, gateRequestSchema, FIREWALL_GATE_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  return completed(evaluateFirewallGate(check.request.payload.observedAtMs ?? 0), [], { firewallGate: FIREWALL_GATE_CONTRACT_VERSION })
}
