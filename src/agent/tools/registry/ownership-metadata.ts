/**
 * G08 / SPEC-076 — Tool ownership metadata.
 *
 * Binds every tool manifest to a real repository ownership zone (G01 / SPEC-003)
 * so "who owns this tool" is machine-checked, not tribal knowledge. Enforces:
 *   - the tool's `zonePrefix` resolves to a known G01 zone,
 *   - that zone is AGENT-side (a tool may never claim ownership inside ERP or a
 *     shared choke point) — fail closed,
 *   - the manifest `team` matches the zone's CODEOWNERS team,
 *   - a domain does not span conflicting teams.
 *
 * Deterministic, no LLM (INV-01): reuses the frozen G01 `resolveOwner`.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  resolveOwner,
  validateRequest,
  type OwnershipZone,
} from '@/agent/contracts'
import { z } from 'zod'
import { toolManifestSchema, type ToolManifest } from '../manifests/manifest.schema'

export const OWNERSHIP_META_CONTRACT_VERSION = '1.0.0' as const

/** Owners that a tool is allowed to belong to (agent-side only). */
const ALLOWED_OWNERS: ReadonlySet<string> = new Set(['agent'])

export interface OwnershipIssue {
  name: string
  code: 'UNOWNED_ZONE' | 'NOT_AGENT_ZONE' | 'INTEGRATION_ONLY' | 'TEAM_MISMATCH'
  detail: string
}

/**
 * Validate one manifest's ownership against the G01 zone registry. Returns every
 * issue (does not throw). Fail-closed: an unresolved or non-agent zone is an
 * error, never a silent pass.
 */
export function checkOwnership(m: ToolManifest): OwnershipIssue[] {
  const issues: OwnershipIssue[] = []
  const zone: OwnershipZone | null = resolveOwner(m.ownership.zonePrefix)
  if (!zone) {
    issues.push({ name: m.name, code: 'UNOWNED_ZONE', detail: m.ownership.zonePrefix })
    return issues
  }
  if (zone.integrationOnly) {
    issues.push({ name: m.name, code: 'INTEGRATION_ONLY', detail: `${zone.prefix} is a shared choke point` })
  }
  if (!ALLOWED_OWNERS.has(zone.owner)) {
    issues.push({ name: m.name, code: 'NOT_AGENT_ZONE', detail: `zone owner '${zone.owner}' is not agent-side` })
  }
  if (m.ownership.team !== zone.team) {
    issues.push({ name: m.name, code: 'TEAM_MISMATCH', detail: `manifest team '${m.ownership.team}' != zone team '${zone.team}'` })
  }
  return issues
}

/** Cross-manifest check: also flags a domain that spans multiple teams. */
export function checkAllOwnership(manifests: readonly ToolManifest[]): OwnershipIssue[] {
  const issues = manifests.flatMap(checkOwnership)
  const teamByDomain = new Map<string, string>()
  for (const m of manifests) {
    const prior = teamByDomain.get(m.domain)
    if (prior && prior !== m.ownership.team) {
      issues.push({ name: m.name, code: 'TEAM_MISMATCH', detail: `domain '${m.domain}' spans teams '${prior}' and '${m.ownership.team}'` })
    } else if (!prior) {
      teamByDomain.set(m.domain, m.ownership.team)
    }
  }
  return issues
}

export interface DomainOwnership {
  domain: string
  team: string
  zonePrefix: string
  toolCount: number
}

/** Deterministic per-domain ownership rollup (sorted by domain). */
export function ownershipByDomain(manifests: readonly ToolManifest[]): DomainOwnership[] {
  const byDomain = new Map<string, DomainOwnership>()
  for (const m of manifests) {
    const existing = byDomain.get(m.domain)
    if (existing) existing.toolCount += 1
    else byDomain.set(m.domain, { domain: m.domain, team: m.ownership.team, zonePrefix: m.ownership.zonePrefix, toolCount: 1 })
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Render a CODEOWNERS-style proposal for tool domains (proposal only). */
export function renderToolCodeowners(manifests: readonly ToolManifest[]): string {
  const lines = [
    '# GENERATED proposal from tool ownership metadata (G08 / SPEC-076).',
    '# Proposal only — the real .github/CODEOWNERS is an integration-only choke point.',
    '',
  ]
  for (const d of ownershipByDomain(manifests)) {
    lines.push(`# domain ${d.domain} (${d.toolCount} tools)`)
    lines.push(`${d.zonePrefix}/ ${d.team}`)
  }
  return lines.join('\n') + '\n'
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const ownershipRequestSchema = z.object({ manifest: z.unknown() })

export function checkToolOwnership(raw: unknown): ComponentResult<{ issues: OwnershipIssue[] }> {
  const check = validateRequest(raw, ownershipRequestSchema, OWNERSHIP_META_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const parsed = toolManifestSchema.safeParse(check.request.payload.manifest)
  if (!parsed.success) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  const issues = checkOwnership(parsed.data)
  // Ownership violations are a policy denial (fail-closed), not a success.
  if (issues.length > 0) {
    return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  }
  return completed({ issues: [] }, [], { ownership: OWNERSHIP_META_CONTRACT_VERSION })
}
