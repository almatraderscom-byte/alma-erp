/**
 * G10 / SPEC-092 — Exact tool shortlist selection.
 *
 * Turns the (possibly large) domain-first candidate set into an EXACT, bounded,
 * deterministically-ranked shortlist the model actually sees. The bound is hard:
 * the shortlist never exceeds `MAX_SHORTLIST`, so a broad intent can never blow
 * the model's tool budget. Ranking is "safest first" (read < stage < write, then
 * low < medium < high risk, then name) so the default surface leans read-only.
 *
 * Deterministic, no LLM (INV-01): ranking is a comparator over declared metadata.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { INTENT_CLASSES } from '@/agent/control-plane/admission'
import { CAPABILITY_SCOPES } from '@/agent/capabilities'
import { getManifest } from '@/agent/tools/manifests'
import { retrieveForIntent } from './retrieval'

export const SHORTLIST_CONTRACT_VERSION = '1.0.0' as const

/** Hard upper bound on a shortlist handed to the model. */
export const MAX_SHORTLIST = 24
export const DEFAULT_SHORTLIST = 12

const MODE_RANK: Record<string, number> = { read: 0, stage: 1, write: 2 }
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }

function rankKey(name: string): [number, number, string] {
  const m = getManifest(name)
  if (!m) return [9, 9, name] // unknown tools sink to the bottom deterministically
  return [MODE_RANK[m.capability.mode] ?? 9, RISK_RANK[m.capability.risk] ?? 9, name]
}

export interface Shortlist {
  toolNames: string[]
  total: number
  truncated: boolean
  cap: number
}

/** Deterministically rank + bound a candidate tool list. Clamps `max` to [1, MAX_SHORTLIST]. */
export function selectShortlist(candidates: readonly string[], max = DEFAULT_SHORTLIST): Shortlist {
  const cap = Math.max(1, Math.min(Math.floor(max), MAX_SHORTLIST))
  const unique = [...new Set(candidates)]
  const ranked = unique.sort((a, b) => {
    const ka = rankKey(a)
    const kb = rankKey(b)
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2])
  })
  const chosen = ranked.slice(0, cap)
  return { toolNames: chosen, total: unique.length, truncated: unique.length > cap, cap }
}

/** Compose retrieval + shortlist for an intent. */
export function shortlistForIntent(
  input: { intentKey?: string; intentClass?: string; actor: { roles: string[] }; requireAvailable?: boolean },
  max = DEFAULT_SHORTLIST,
): Shortlist & { resolved: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const retrieval = retrieveForIntent(input as any)
  const sl = selectShortlist(retrieval.toolNames, max)
  return { ...sl, resolved: retrieval.resolved }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const shortlistRequestSchema = z
  .object({
    intentKey: z.string().min(1).optional(),
    intentClass: z.enum(INTENT_CLASSES).optional(),
    actor: z.object({ roles: z.array(z.enum(CAPABILITY_SCOPES)) }),
    max: z.number().int().positive().optional(),
    requireAvailable: z.boolean().optional(),
  })
  .refine((v) => v.intentKey !== undefined || v.intentClass !== undefined, { message: 'intentKey or intentClass required' })

export function selectToolShortlist(raw: unknown): ComponentResult<Shortlist> {
  const check = validateRequest(raw, shortlistRequestSchema, SHORTLIST_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const result = shortlistForIntent(p, p.max ?? DEFAULT_SHORTLIST)
  if (!result.resolved || result.toolNames.length === 0) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  const { resolved, ...shortlist } = result
  void resolved
  return completed(shortlist, [], { shortlist: SHORTLIST_CONTRACT_VERSION })
}
