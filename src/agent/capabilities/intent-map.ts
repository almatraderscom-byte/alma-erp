/**
 * G09 / SPEC-082 — Capability-to-intent mapping.
 *
 * Two indexes over the capability catalog:
 *   - business-intent key → capabilities  (e.g. "manage_finance" → [cap.finance])
 *   - G02 IntentClass      → capabilities  (e.g. "command" → all write-bearing caps)
 * plus the consistency rules that keep the two coherent:
 *   - a `manage_*`/`create_*`/`launch_*` intent implies the capability serves a
 *     mutating admission class ('command' or 'task'),
 *   - a read-only (`query_*`-only) capability serves 'question'.
 *
 * Deterministic, no LLM (INV-01): intent resolution is index lookup, never a model
 * judgement.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { INTENT_CLASSES, type IntentClass } from '@/agent/control-plane/admission/intent'
import { CAPABILITIES } from './store'
import type { Capability } from './capability.schema'

export const INTENT_MAP_CONTRACT_VERSION = '1.0.0' as const

/** Verb prefixes that mean "this intent mutates state". */
const MUTATING_PREFIXES = ['manage_', 'create_', 'launch_', 'update_', 'send_', 'delete_']
/** Admission classes that carry a mutation. */
const MUTATING_CLASSES: ReadonlySet<IntentClass> = new Set(['command', 'task'])

function buildByIntent(): Map<string, Capability[]> {
  const idx = new Map<string, Capability[]>()
  for (const c of CAPABILITIES) for (const key of c.intents) (idx.get(key) ?? idx.set(key, []).get(key)!).push(c)
  return idx
}
function buildByClass(): Map<IntentClass, Capability[]> {
  const idx = new Map<IntentClass, Capability[]>()
  for (const c of CAPABILITIES) for (const cls of c.intentClasses) (idx.get(cls) ?? idx.set(cls, []).get(cls)!).push(c)
  return idx
}

const BY_INTENT = buildByIntent()
const BY_CLASS = buildByClass()

export function capabilitiesForIntent(intentKey: string): Capability[] {
  return (BY_INTENT.get(intentKey) ?? []).slice().sort((a, b) => a.key.localeCompare(b.key))
}
export function capabilitiesForClass(cls: IntentClass): Capability[] {
  return (BY_CLASS.get(cls) ?? []).slice().sort((a, b) => a.key.localeCompare(b.key))
}
export function allIntentKeys(): string[] {
  return [...BY_INTENT.keys()].sort()
}

export interface IntentIssue {
  capability: string
  code: 'NO_INTENT' | 'NO_CLASS' | 'MUTATING_INTENT_WITHOUT_CLASS' | 'UNKNOWN_CLASS'
  detail: string
}

function isMutatingIntent(key: string): boolean {
  return MUTATING_PREFIXES.some((p) => key.startsWith(p))
}

/** Consistency of one capability's intent/class surface (no throw). */
export function checkIntentMapping(c: Capability): IntentIssue[] {
  const issues: IntentIssue[] = []
  if (c.intents.length === 0) issues.push({ capability: c.key, code: 'NO_INTENT', detail: 'no intents' })
  if (c.intentClasses.length === 0) issues.push({ capability: c.key, code: 'NO_CLASS', detail: 'no intent classes' })
  for (const cls of c.intentClasses) {
    if (!(INTENT_CLASSES as readonly string[]).includes(cls)) issues.push({ capability: c.key, code: 'UNKNOWN_CLASS', detail: cls })
  }
  const hasMutatingIntent = c.intents.some(isMutatingIntent)
  const servesMutatingClass = c.intentClasses.some((cls) => MUTATING_CLASSES.has(cls))
  if (hasMutatingIntent && !servesMutatingClass) {
    issues.push({ capability: c.key, code: 'MUTATING_INTENT_WITHOUT_CLASS', detail: `${c.intents.filter(isMutatingIntent).join(',')} but classes=${c.intentClasses.join(',')}` })
  }
  return issues
}

export function checkAllIntentMappings(caps: readonly Capability[] = CAPABILITIES): IntentIssue[] {
  return caps.flatMap(checkIntentMapping)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const intentRequestSchema = z.union([
  z.object({ kind: z.literal('byIntent'), intentKey: z.string().min(1) }),
  z.object({ kind: z.literal('byClass'), intentClass: z.enum(INTENT_CLASSES) }),
  z.object({ kind: z.literal('keys') }),
])
export type IntentMapRequest = z.infer<typeof intentRequestSchema>

export type IntentMapResultValue =
  | { kind: 'list'; capabilityKeys: string[] }
  | { kind: 'keys'; intentKeys: string[] }

export function queryIntentMap(raw: unknown): ComponentResult<IntentMapResultValue> {
  const check = validateRequest(raw, intentRequestSchema, INTENT_MAP_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { intentMap: INTENT_MAP_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'byIntent':
      return completed({ kind: 'list', capabilityKeys: capabilitiesForIntent(q.intentKey).map((c) => c.key) }, [], versions)
    case 'byClass':
      return completed({ kind: 'list', capabilityKeys: capabilitiesForClass(q.intentClass).map((c) => c.key) }, [], versions)
    case 'keys':
      return completed({ kind: 'keys', intentKeys: allIntentKeys() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
