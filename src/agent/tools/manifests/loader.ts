/**
 * G08 / SPEC-073 — Domain package loader (runtime aggregation).
 *
 * Assembles the generated `DOMAIN_PACKAGES` into a single validated manifest set:
 * every package valid in isolation, tool names globally unique across domains,
 * and a fast name→manifest index. Fail-closed: a corrupt package throws at load
 * so no downstream consumer sees a partial registry.
 *
 * Deterministic: reads only the committed generated data (no monolith/prisma/
 * network/model, INV-01).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { DOMAIN_PACKAGES } from './domains.generated'
import { validateDomainPackage, type DomainPackage, type PackageIssue } from './domain-package'
import type { ToolManifest } from './manifest.schema'

export const LOADER_CONTRACT_VERSION = '1.0.0' as const

export interface GlobalIssue extends PackageIssue {}

/** Validate all packages + global name uniqueness. Returns every issue (no throw). */
export function validateAll(packages: readonly DomainPackage[]): GlobalIssue[] {
  const issues: GlobalIssue[] = []
  const globalNames = new Map<string, string>() // name -> domain
  const domainsSeen = new Set<string>()
  for (const pkg of packages) {
    if (domainsSeen.has(pkg.domain)) {
      issues.push({ domain: pkg.domain, code: 'DUPLICATE_NAME', detail: `domain '${pkg.domain}' appears twice` })
    }
    domainsSeen.add(pkg.domain)
    issues.push(...validateDomainPackage(pkg))
    for (const m of pkg.manifests) {
      const prior = globalNames.get(m.name)
      if (prior && prior !== pkg.domain) {
        issues.push({ domain: pkg.domain, code: 'DUPLICATE_NAME', detail: `${m.name} also in domain '${prior}'` })
      }
      globalNames.set(m.name, pkg.domain)
    }
  }
  return issues
}

interface LoadedRegistry {
  packages: readonly DomainPackage[]
  manifests: readonly ToolManifest[]
  byName: ReadonlyMap<string, ToolManifest>
  byDomain: ReadonlyMap<string, readonly ToolManifest[]>
}

function load(): LoadedRegistry {
  const issues = validateAll(DOMAIN_PACKAGES)
  if (issues.length > 0) {
    throw new Error(
      `manifest loader: ${issues.length} issue(s): ` +
        issues.slice(0, 5).map((i) => `${i.domain}/${i.code}(${i.detail})`).join('; '),
    )
  }
  const manifests: ToolManifest[] = []
  const byName = new Map<string, ToolManifest>()
  const byDomain = new Map<string, ToolManifest[]>()
  for (const pkg of DOMAIN_PACKAGES) {
    byDomain.set(pkg.domain, pkg.manifests)
    for (const m of pkg.manifests) {
      manifests.push(m)
      byName.set(m.name, m)
    }
  }
  manifests.sort((a, b) => a.name.localeCompare(b.name))
  return { packages: DOMAIN_PACKAGES, manifests, byName, byDomain }
}

const REGISTRY = load()

export const ALL_MANIFESTS: readonly ToolManifest[] = REGISTRY.manifests
export const ALL_PACKAGES: readonly DomainPackage[] = REGISTRY.packages

export function getManifest(name: string): ToolManifest | undefined {
  return REGISTRY.byName.get(name)
}

export function manifestsForDomain(domain: string): readonly ToolManifest[] {
  return REGISTRY.byDomain.get(domain) ?? []
}

export function domains(): string[] {
  return [...REGISTRY.byDomain.keys()].sort()
}

export function manifestCount(): number {
  return REGISTRY.manifests.length
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

export type LoaderQuery =
  | { kind: 'get'; name: string }
  | { kind: 'byDomain'; domain: string }
  | { kind: 'domains' }
  | { kind: 'count' }

const loaderQuerySchema: z.ZodType<LoaderQuery> = z.union([
  z.object({ kind: z.literal('get'), name: z.string().min(1) }),
  z.object({ kind: z.literal('byDomain'), domain: z.string().min(1) }),
  z.object({ kind: z.literal('domains') }),
  z.object({ kind: z.literal('count') }),
])

export type LoaderResultValue =
  | { kind: 'get'; manifest: ToolManifest | null }
  | { kind: 'list'; manifests: readonly ToolManifest[] }
  | { kind: 'domains'; domains: string[] }
  | { kind: 'count'; count: number }

export function queryManifests(raw: unknown): ComponentResult<LoaderResultValue> {
  const check = validateRequest(raw, loaderQuerySchema, LOADER_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { loader: LOADER_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'get':
      return completed({ kind: 'get', manifest: getManifest(q.name) ?? null }, [], versions)
    case 'byDomain':
      return completed({ kind: 'list', manifests: manifestsForDomain(q.domain) }, [], versions)
    case 'domains':
      return completed({ kind: 'domains', domains: domains() }, [], versions)
    case 'count':
      return completed({ kind: 'count', count: manifestCount() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
