/**
 * G08 / SPEC-078 — Tool deprecation and migration.
 *
 * The lifecycle engine over `manifest.status` + `manifest.deprecation`:
 *   - CALLABILITY: an `active`/`preview` tool is callable; a `deprecated` tool is
 *     callable but returns a migration warning; a `removed` tool is NOT callable
 *     (fail-closed) and callers are pointed at its replacement.
 *   - MIGRATION: `replacedBy` forms a chain; `resolveMigration` follows it to the
 *     terminal successor, detecting cycles (fail-closed, never loops forever).
 *   - INTEGRITY: `removeAfter` must be strictly after `since`; every `replacedBy`
 *     target must exist; no cycles.
 *
 * Deterministic, no LLM (INV-01).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { toolManifestSchema, type ToolManifest } from '../manifests/manifest.schema'
import { compareSemver } from './versioning'
import { ALL_MANIFESTS, getManifest } from '../manifests/loader'

export const DEPRECATION_CONTRACT_VERSION = '1.0.0' as const

export interface Callability {
  name: string
  status: ToolManifest['status']
  callable: boolean
  /** Migration target when deprecated/removed. */
  replacedBy?: string
  warning?: string
}

/** Decide whether a tool may be called, and what to tell the caller. */
export function callability(m: ToolManifest): Callability {
  switch (m.status) {
    case 'active':
    case 'preview':
      return { name: m.name, status: m.status, callable: true }
    case 'deprecated':
      return {
        name: m.name,
        status: m.status,
        callable: true,
        replacedBy: m.deprecation?.replacedBy,
        warning: `'${m.name}' is deprecated${m.deprecation?.replacedBy ? `; use '${m.deprecation.replacedBy}'` : ''}.`,
      }
    case 'removed':
      return {
        name: m.name,
        status: m.status,
        callable: false, // fail-closed: a removed tool cannot run
        replacedBy: m.deprecation?.replacedBy,
        warning: `'${m.name}' was removed${m.deprecation?.replacedBy ? `; use '${m.deprecation.replacedBy}'` : ''}.`,
      }
    default:
      return { name: m.name, status: m.status, callable: false, warning: 'unknown status' }
  }
}

export interface MigrationResolution {
  target: string
  chain: string[]
  cycle: boolean
  unresolved: boolean
}

/**
 * Follow the `replacedBy` chain from `name` to the terminal active successor.
 * Cycle-safe: a repeated name stops the walk with `cycle: true`. A `replacedBy`
 * pointing at a non-existent tool stops with `unresolved: true`.
 */
export function resolveMigration(name: string, lookup: (n: string) => ToolManifest | undefined = getManifest): MigrationResolution {
  const chain: string[] = []
  const seen = new Set<string>()
  let current = name
  for (;;) {
    if (seen.has(current)) return { target: current, chain, cycle: true, unresolved: false }
    seen.add(current)
    chain.push(current)
    const m = lookup(current)
    if (!m) return { target: current, chain, cycle: false, unresolved: chain.length > 1 }
    const next = m.deprecation?.replacedBy
    if (!next) return { target: current, chain, cycle: false, unresolved: false }
    current = next
  }
}

export interface DeprecationIssue {
  name: string
  code: 'BAD_REMOVE_ORDER' | 'MISSING_REPLACEMENT' | 'MIGRATION_CYCLE'
  detail: string
}

/** Validate one manifest's deprecation record integrity. */
export function checkDeprecation(m: ToolManifest, lookup: (n: string) => ToolManifest | undefined = getManifest): DeprecationIssue[] {
  const issues: DeprecationIssue[] = []
  const dep = m.deprecation
  if (!dep) return issues
  if (dep.removeAfter && compareSemver(dep.removeAfter, dep.since) <= 0) {
    issues.push({ name: m.name, code: 'BAD_REMOVE_ORDER', detail: `removeAfter ${dep.removeAfter} not after since ${dep.since}` })
  }
  if (dep.replacedBy && !lookup(dep.replacedBy)) {
    issues.push({ name: m.name, code: 'MISSING_REPLACEMENT', detail: dep.replacedBy })
  }
  const res = resolveMigration(m.name, lookup)
  if (res.cycle) issues.push({ name: m.name, code: 'MIGRATION_CYCLE', detail: res.chain.join(' -> ') })
  return issues
}

/** Whole-set integrity check. */
export function checkAllDeprecations(manifests: readonly ToolManifest[] = ALL_MANIFESTS): DeprecationIssue[] {
  const byName = new Map(manifests.map((m) => [m.name, m]))
  const lookup = (n: string) => byName.get(n)
  return manifests.flatMap((m) => checkDeprecation(m, lookup))
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const deprecationRequestSchema = z.union([
  z.object({ kind: z.literal('callability'), manifest: z.unknown() }),
  z.object({ kind: z.literal('resolveMigration'), name: z.string().min(1) }),
])
export type DeprecationRequest = z.infer<typeof deprecationRequestSchema>

export type DeprecationResultValue =
  | { kind: 'callability'; result: Callability }
  | { kind: 'resolveMigration'; result: MigrationResolution }

export function queryDeprecation(raw: unknown): ComponentResult<DeprecationResultValue> {
  const check = validateRequest(raw, deprecationRequestSchema, DEPRECATION_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { deprecation: DEPRECATION_CONTRACT_VERSION }
  const q = check.request.payload
  if (q.kind === 'callability') {
    const parsed = toolManifestSchema.safeParse(q.manifest)
    if (!parsed.success) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
    return completed({ kind: 'callability', result: callability(parsed.data) }, [], versions)
  }
  return completed({ kind: 'resolveMigration', result: resolveMigration(q.name) }, [], versions)
}
