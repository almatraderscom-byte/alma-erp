/**
 * G10 / SPEC-091 — Domain-first tool retrieval.
 *
 * The first stage of the tool-selection firewall: instead of exposing all 326
 * tools to the model, retrieve only the tools of the DOMAIN(S) relevant to the
 * request. It reuses the G09 capability resolver (which already applies intent,
 * permission and health filters) so retrieval is permission-scoped by
 * construction — an actor never even sees tools it may not use.
 *
 * Deterministic, no LLM (INV-01): retrieval is index + set union, never a model
 * ranking. Fail-closed: an intent that resolves to nothing returns an empty,
 * explicitly-unresolved result — never the full surface as a fallback.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { INTENT_CLASSES } from '@/agent/control-plane/admission/intent'
import { CAPABILITY_SCOPES } from '@/agent/capabilities'
import { resolveCapabilities, type ResolveInput } from '@/agent/capabilities'
import { manifestsForDomain, domains as allDomains, getManifest } from '@/agent/tools/manifests'

export const RETRIEVAL_CONTRACT_VERSION = '1.0.0' as const

export interface RetrievalResult {
  /** Domains (capability keys) the request resolved to. */
  domains: string[]
  /** Tool names available in those domains, permission-scoped + sorted. */
  toolNames: string[]
  /** How many capabilities the resolver considered (diagnostics). */
  consideredCapabilities: number
  resolved: boolean
}

/** Tools of a single domain (from the decoupled G08 loader), sorted. */
export function retrieveByDomain(domain: string): string[] {
  return manifestsForDomain(domain).map((m) => m.name).slice().sort()
}

/**
 * Domain-first retrieval for an intent + actor. Unions the tool names of every
 * capability the G09 resolver returns (already permission/health filtered).
 */
export function retrieveForIntent(input: ResolveInput): RetrievalResult {
  const resolution = resolveCapabilities(input)
  const names = new Set<string>()
  for (const cand of resolution.candidates) {
    for (const n of retrieveByDomain(cand.key)) names.add(n)
  }
  return {
    domains: resolution.candidates.map((c) => c.key).sort(),
    toolNames: [...names].sort(),
    consideredCapabilities: resolution.considered,
    resolved: resolution.resolved,
  }
}

/** Guard: is this tool name a real, retrievable tool? */
export function isRetrievableTool(name: string): boolean {
  return getManifest(name) !== undefined
}

export function knownDomains(): string[] {
  return allDomains()
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const retrievalRequestSchema = z
  .object({
    intentKey: z.string().min(1).optional(),
    intentClass: z.enum(INTENT_CLASSES).optional(),
    domain: z.string().min(1).optional(),
    actor: z.object({ roles: z.array(z.enum(CAPABILITY_SCOPES)) }),
    requireAvailable: z.boolean().optional(),
  })
  .refine((v) => v.intentKey !== undefined || v.intentClass !== undefined || v.domain !== undefined, {
    message: 'intentKey, intentClass or domain required',
  })

export function retrieveTools(raw: unknown): ComponentResult<RetrievalResult> {
  const check = validateRequest(raw, retrievalRequestSchema, RETRIEVAL_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const versions = { retrieval: RETRIEVAL_CONTRACT_VERSION }

  // A direct domain request bypasses the resolver but stays permission-neutral:
  // it returns the domain's tools for inspection (selection/validation still gate
  // execution downstream). Intent requests go through the permission-scoped resolver.
  if (p.domain && p.intentKey === undefined && p.intentClass === undefined) {
    const toolNames = retrieveByDomain(p.domain)
    if (toolNames.length === 0) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
    return completed({ domains: [p.domain], toolNames, consideredCapabilities: 0, resolved: true }, [], versions)
  }

  const result = retrieveForIntent(p)
  if (!result.resolved) return failure('DENIED', [REASON_CODES.POLICY_DENIED])
  return completed(result, [], versions)
}
