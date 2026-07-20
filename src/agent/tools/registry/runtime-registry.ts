/**
 * G08 / SPEC-079 — Generated runtime registry.
 *
 * The capstone: assembles the decomposed facets (manifests + IO schema + risk
 * classification + versioning + deprecation) into ONE runtime registry that can
 * stand in for the monolith's `TOOLS` / `TOOL_DEFINITIONS`. It is driven by the
 * G01 feature-flag ladder (off→shadow→warn→enforce→rollback, INV-08):
 *   - off/shadow/warn/rollback → the LEGACY monolith stays authoritative,
 *   - enforce                  → this NEW registry is authoritative.
 * A shadow comparison against the SPEC-071 inventory proves parity before any
 * enforce switch (migration evidence, INV-09).
 *
 * Deterministic, no LLM (INV-01): the registry is derived data, not a model call.
 */
import {
  type ComponentResult,
  type FeatureMode,
  decide,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { ALL_MANIFESTS } from '../manifests/loader'
import type { ToolManifest } from '../manifests/manifest.schema'
import { classifyManifest, type RiskProfile } from './risk-classification'
import { callability } from './deprecation'
import { getSchema } from './io-schema'
import { TOOL_INVENTORY } from './inventory'

export const RUNTIME_CONTRACT_VERSION = '1.0.0' as const

export interface RuntimeToolEntry {
  name: string
  domain: string
  version: string
  status: ToolManifest['status']
  description: string
  /** Resolved input schema (from the IO registry), or undefined if unregistered. */
  inputSchema: unknown
  risk: RiskProfile
  callable: boolean
  routing: ToolManifest['routing']
}

/** Model-facing tool definition (the shape that replaces `TOOL_DEFINITIONS`). */
export interface RuntimeToolDefinition {
  name: string
  description: string
  input_schema: unknown
}

export interface RuntimeRegistry {
  mode: FeatureMode
  /** Which path decides tool execution under this mode. */
  authoritative: 'legacy' | 'new'
  entries: RuntimeToolEntry[]
  byName: ReadonlyMap<string, RuntimeToolEntry>
  toolCount: number
  callableCount: number
}

function buildEntry(m: ToolManifest): RuntimeToolEntry {
  return {
    name: m.name,
    domain: m.domain,
    version: m.version,
    status: m.status,
    description: m.summary,
    inputSchema: getSchema(m.io.inputSchemaId),
    risk: classifyManifest(m),
    callable: callability(m).callable,
    routing: m.routing,
  }
}

/**
 * Build the runtime registry for a feature mode. Under `enforce` only CALLABLE
 * tools are exposed (removed tools are dropped, fail-closed); under legacy-
 * authoritative modes the full set is built for shadow comparison.
 */
export function buildRuntimeRegistry(mode: FeatureMode, manifests: readonly ToolManifest[] = ALL_MANIFESTS): RuntimeRegistry {
  const d = decide(mode)
  const authoritative: 'legacy' | 'new' = d.newAuthoritative ? 'new' : 'legacy'
  const all = manifests.map(buildEntry)
  const entries = (authoritative === 'new' ? all.filter((e) => e.callable) : all).sort((a, b) => a.name.localeCompare(b.name))
  const byName = new Map(entries.map((e) => [e.name, e]))
  return {
    mode,
    authoritative,
    entries,
    byName,
    toolCount: entries.length,
    callableCount: entries.filter((e) => e.callable).length,
  }
}

/** Model-facing definitions for a built registry (replaces TOOL_DEFINITIONS). */
export function toolDefinitions(registry: RuntimeRegistry): RuntimeToolDefinition[] {
  return registry.entries.map((e) => ({
    name: e.name,
    description: e.description,
    input_schema: e.inputSchema ?? { type: 'object', properties: {} },
  }))
}

export interface ShadowComparison {
  matched: number
  onlyInNew: string[]
  onlyInInventory: string[]
  parity: boolean
}

/**
 * Shadow comparison (migration evidence, INV-09): the NEW registry's tool set vs
 * the SPEC-071 inventory snapshot of the monolith. Parity means the decomposition
 * lost/added nothing — the precondition the removal gate (SPEC-080) will require.
 */
export function shadowCompare(manifests: readonly ToolManifest[] = ALL_MANIFESTS): ShadowComparison {
  const newNames = new Set(manifests.map((m) => m.name))
  const invNames = new Set(TOOL_INVENTORY.map((r) => r.name))
  const onlyInNew = [...newNames].filter((n) => !invNames.has(n)).sort()
  const onlyInInventory = [...invNames].filter((n) => !newNames.has(n)).sort()
  return {
    matched: [...newNames].filter((n) => invNames.has(n)).length,
    onlyInNew,
    onlyInInventory,
    parity: onlyInNew.length === 0 && onlyInInventory.length === 0,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const runtimeRequestSchema = z.union([
  z.object({ kind: z.literal('build'), mode: z.enum(['off', 'shadow', 'warn', 'enforce', 'rollback']) }),
  z.object({ kind: z.literal('definitions'), mode: z.enum(['off', 'shadow', 'warn', 'enforce', 'rollback']) }),
  z.object({ kind: z.literal('shadowCompare') }),
])
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>

export type RuntimeResultValue =
  | { kind: 'build'; mode: FeatureMode; authoritative: 'legacy' | 'new'; toolCount: number; callableCount: number }
  | { kind: 'definitions'; count: number; definitions: RuntimeToolDefinition[] }
  | { kind: 'shadowCompare'; comparison: ShadowComparison }

export function queryRuntimeRegistry(raw: unknown): ComponentResult<RuntimeResultValue> {
  const check = validateRequest(raw, runtimeRequestSchema, RUNTIME_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { runtime: RUNTIME_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'build': {
      const r = buildRuntimeRegistry(q.mode)
      return completed({ kind: 'build', mode: r.mode, authoritative: r.authoritative, toolCount: r.toolCount, callableCount: r.callableCount }, [], versions)
    }
    case 'definitions': {
      const defs = toolDefinitions(buildRuntimeRegistry(q.mode))
      return completed({ kind: 'definitions', count: defs.length, definitions: defs }, [], versions)
    }
    case 'shadowCompare':
      return completed({ kind: 'shadowCompare', comparison: shadowCompare() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
