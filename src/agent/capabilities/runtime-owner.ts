/**
 * G09 / SPEC-086 — Capability runtime and owner metadata.
 *
 * Validates two facets against ground truth:
 *   - RUNTIME: a capability's `runtime.groups`/`pools` must equal the union of
 *     the routing surfaces of its G08 tools (a capability cannot advertise a head
 *     group or execution pool none of its tools actually run in).
 *   - OWNER: `owner.zonePrefix` must resolve to a real G01 ownership zone that is
 *     agent-side, and `owner.team` must match that zone's CODEOWNERS team.
 *
 * Deterministic, no LLM (INV-01). Reuses the frozen G01 `resolveOwner` and the
 * decoupled G08 manifest loader.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  resolveOwner,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { getManifest } from '@/agent/tools/manifests'
import type { Capability } from './capability.schema'
import { capabilityStore } from './store'

export const RUNTIME_OWNER_CONTRACT_VERSION = '1.0.0' as const

const ALLOWED_OWNERS: ReadonlySet<string> = new Set(['agent'])

/** Union of routing groups/pools across a capability's tools. */
export function expectedRuntime(toolNames: readonly string[]): { groups: string[]; pools: string[] } {
  const groups = new Set<string>()
  const pools = new Set<string>()
  for (const name of toolNames) {
    const m = getManifest(name)
    if (!m) continue
    for (const g of m.routing.groups) groups.add(g)
    for (const p of m.routing.pools) pools.add(p)
  }
  return { groups: [...groups].sort(), pools: [...pools].sort() }
}

export interface RuntimeOwnerIssue {
  capability: string
  code: 'RUNTIME_GROUPS_MISMATCH' | 'RUNTIME_POOLS_MISMATCH' | 'UNOWNED_ZONE' | 'NOT_AGENT_ZONE' | 'INTEGRATION_ONLY' | 'TEAM_MISMATCH'
  detail: string
}

const eq = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export function checkRuntimeOwner(c: Capability): RuntimeOwnerIssue[] {
  const issues: RuntimeOwnerIssue[] = []
  const exp = expectedRuntime(c.toolNames)
  const declaredGroups = [...c.runtime.groups].sort()
  const declaredPools = [...c.runtime.pools].sort()
  if (!eq(declaredGroups, exp.groups)) issues.push({ capability: c.key, code: 'RUNTIME_GROUPS_MISMATCH', detail: `declared=[${declaredGroups}] expected=[${exp.groups}]` })
  if (!eq(declaredPools, exp.pools)) issues.push({ capability: c.key, code: 'RUNTIME_POOLS_MISMATCH', detail: `declared=[${declaredPools}] expected=[${exp.pools}]` })

  const zone = resolveOwner(c.owner.zonePrefix)
  if (!zone) {
    issues.push({ capability: c.key, code: 'UNOWNED_ZONE', detail: c.owner.zonePrefix })
  } else {
    if (zone.integrationOnly) issues.push({ capability: c.key, code: 'INTEGRATION_ONLY', detail: zone.prefix })
    if (!ALLOWED_OWNERS.has(zone.owner)) issues.push({ capability: c.key, code: 'NOT_AGENT_ZONE', detail: `owner=${zone.owner}` })
    if (c.owner.team !== zone.team) issues.push({ capability: c.key, code: 'TEAM_MISMATCH', detail: `team=${c.owner.team} zoneTeam=${zone.team}` })
  }
  return issues
}

export function checkAllRuntimeOwner(caps: readonly Capability[] = capabilityStore.list()): RuntimeOwnerIssue[] {
  return caps.flatMap(checkRuntimeOwner)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const runtimeOwnerRequestSchema = z.object({ capabilityKey: z.string().min(1) })

export function queryRuntimeOwner(raw: unknown): ComponentResult<{ issues: RuntimeOwnerIssue[] }> {
  const check = validateRequest(raw, runtimeOwnerRequestSchema, RUNTIME_OWNER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const cap = capabilityStore.getByKey(check.request.payload.capabilityKey)
  if (!cap) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  const issues = checkRuntimeOwner(cap)
  if (issues.length > 0) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  return completed({ issues: [] }, [], { runtimeOwner: RUNTIME_OWNER_CONTRACT_VERSION })
}
