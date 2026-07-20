/**
 * G09 / SPEC-083 — Capability-to-tool mapping.
 *
 * Binds each capability to the concrete G08 tools that fulfil it, and validates
 * the binding against the real manifest loader:
 *   - every `toolNames` entry must resolve to a live manifest (no phantom tools),
 *   - the capability set must COVER every tool exactly once (a tool routed to no
 *     capability is unreachable via the control plane; a tool in two capabilities
 *     is ambiguous).
 *
 * Reads the DECOUPLED G08 manifest loader (deterministic, no prisma/network/model,
 * INV-01). Fail-closed: unknown tools are hard issues, never silently dropped.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { getManifest, ALL_MANIFESTS, type ToolManifest } from '@/agent/tools/manifests'
import { CAPABILITIES } from './store'
import type { Capability } from './capability.schema'

export const TOOL_MAP_CONTRACT_VERSION = '1.0.0' as const

/** Resolve the manifests backing a capability (missing tools are skipped here; see checks). */
export function toolsForCapability(key: string): ToolManifest[] {
  const cap = CAPABILITIES.find((c) => c.key === key)
  if (!cap) return []
  return cap.toolNames.map(getManifest).filter((m): m is ToolManifest => m !== undefined)
}

const REVERSE: ReadonlyMap<string, string[]> = (() => {
  const idx = new Map<string, string[]>()
  for (const c of CAPABILITIES) for (const t of c.toolNames) (idx.get(t) ?? idx.set(t, []).get(t)!).push(c.key)
  return idx
})()

/** Which capability(ies) route to a given tool. */
export function capabilitiesForTool(toolName: string): string[] {
  return (REVERSE.get(toolName) ?? []).slice().sort()
}

export interface ToolMapIssue {
  capability: string
  code: 'MISSING_TOOL' | 'DUPLICATE_ROUTING' | 'UNCOVERED_TOOL'
  detail: string
}

/** Per-capability: every declared tool exists in G08. */
export function checkToolMapping(c: Capability): ToolMapIssue[] {
  const issues: ToolMapIssue[] = []
  for (const t of c.toolNames) {
    if (!getManifest(t)) issues.push({ capability: c.key, code: 'MISSING_TOOL', detail: t })
  }
  return issues
}

/**
 * Whole-set: every capability tool exists; every G08 tool is covered by exactly
 * one capability. UNCOVERED_TOOL / DUPLICATE_ROUTING are reported against a
 * synthetic '(catalog)' owner.
 */
export function checkAllToolMappings(caps: readonly Capability[] = CAPABILITIES): ToolMapIssue[] {
  const issues: ToolMapIssue[] = caps.flatMap(checkToolMapping)
  const routedCount = new Map<string, number>()
  for (const c of caps) for (const t of c.toolNames) routedCount.set(t, (routedCount.get(t) ?? 0) + 1)
  for (const [tool, n] of routedCount) {
    if (n > 1) issues.push({ capability: '(catalog)', code: 'DUPLICATE_ROUTING', detail: `${tool} routed by ${n} capabilities` })
  }
  for (const m of ALL_MANIFESTS) {
    if (!routedCount.has(m.name)) issues.push({ capability: '(catalog)', code: 'UNCOVERED_TOOL', detail: m.name })
  }
  return issues
}

export interface CoverageReport {
  totalTools: number
  routedTools: number
  uncovered: string[]
  duplicated: string[]
}

export function coverage(caps: readonly Capability[] = CAPABILITIES): CoverageReport {
  const routed = new Map<string, number>()
  for (const c of caps) for (const t of c.toolNames) routed.set(t, (routed.get(t) ?? 0) + 1)
  const uncovered = ALL_MANIFESTS.filter((m) => !routed.has(m.name)).map((m) => m.name).sort()
  const duplicated = [...routed.entries()].filter(([, n]) => n > 1).map(([t]) => t).sort()
  return { totalTools: ALL_MANIFESTS.length, routedTools: routed.size, uncovered, duplicated }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const toolMapRequestSchema = z.union([
  z.object({ kind: z.literal('toolsFor'), key: z.string().min(1) }),
  z.object({ kind: z.literal('capsFor'), toolName: z.string().min(1) }),
  z.object({ kind: z.literal('coverage') }),
])
export type ToolMapRequest = z.infer<typeof toolMapRequestSchema>

export type ToolMapResultValue =
  | { kind: 'tools'; toolNames: string[] }
  | { kind: 'caps'; capabilityKeys: string[] }
  | { kind: 'coverage'; report: CoverageReport }

export function queryToolMap(raw: unknown): ComponentResult<ToolMapResultValue> {
  const check = validateRequest(raw, toolMapRequestSchema, TOOL_MAP_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { toolMap: TOOL_MAP_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'toolsFor':
      return completed({ kind: 'tools', toolNames: toolsForCapability(q.key).map((m) => m.name) }, [], versions)
    case 'capsFor':
      return completed({ kind: 'caps', capabilityKeys: capabilitiesForTool(q.toolName) }, [], versions)
    case 'coverage':
      return completed({ kind: 'coverage', report: coverage() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
