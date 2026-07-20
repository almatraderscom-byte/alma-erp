/**
 * G08 / SPEC-077 — Tool versioning.
 *
 * Deterministic semver (MAJOR.MINOR.PATCH) for tool contracts, plus the two
 * decisions the registry actually needs:
 *   - COMPATIBILITY: a caller pinned to vX can use an available vY iff same MAJOR
 *     and Y >= X (minor/patch are additive; a MAJOR bump is breaking).
 *   - TRANSITION LEGALITY: a tool may only move forward, and the size of the bump
 *     (major/minor/patch) must be declared truthfully.
 *
 * No LLM, no I/O (INV-01): version math is arithmetic, never a model judgement.
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { SEMVER_RE } from '../manifests/manifest.schema'
import { getManifest } from '../manifests/loader'

export const VERSIONING_CONTRACT_VERSION = '1.0.0' as const

export interface Semver {
  major: number
  minor: number
  patch: number
}

/** Parse a strict semver string, or null if malformed. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER_RE.exec(v)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** -1 | 0 | 1 comparing a to b. Throws on malformed input (callers pre-validate). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) throw new Error(`invalid semver: ${!pa ? a : b}`)
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] < pb[k]) return -1
    if (pa[k] > pb[k]) return 1
  }
  return 0
}

/**
 * Compatibility: can a caller that pinned `requested` be served by `available`?
 * Same MAJOR and available >= requested. Returns false on any malformed input
 * (fail-closed).
 */
export function isCompatible(requested: string, available: string): boolean {
  const pr = parseSemver(requested)
  const pa = parseSemver(available)
  if (!pr || !pa) return false
  if (pr.major !== pa.major) return false
  return compareSemver(available, requested) >= 0
}

export type BumpKind = 'none' | 'patch' | 'minor' | 'major' | 'downgrade' | 'invalid'

/** Classify the transition from `from` to `to`. */
export function bumpKind(from: string, to: string): BumpKind {
  const a = parseSemver(from)
  const b = parseSemver(to)
  if (!a || !b) return 'invalid'
  const cmp = compareSemver(to, from)
  if (cmp < 0) return 'downgrade'
  if (cmp === 0) return 'none'
  if (b.major > a.major) return 'major'
  if (b.minor > a.minor) return 'minor'
  return 'patch'
}

export interface TransitionCheck {
  legal: boolean
  kind: BumpKind
  reason?: string
}

/**
 * A version transition is legal iff it moves strictly forward (no downgrade, no
 * no-op re-release) and both versions parse. `declaredBreaking` must be true for
 * a MAJOR bump and false otherwise — a lie about breakingness is illegal.
 */
export function checkTransition(from: string, to: string, declaredBreaking: boolean): TransitionCheck {
  const kind = bumpKind(from, to)
  if (kind === 'invalid') return { legal: false, kind, reason: 'malformed semver' }
  if (kind === 'downgrade') return { legal: false, kind, reason: 'downgrade not allowed' }
  if (kind === 'none') return { legal: false, kind, reason: 'version unchanged' }
  const isMajor = kind === 'major'
  if (isMajor !== declaredBreaking) {
    return { legal: false, kind, reason: `declaredBreaking=${declaredBreaking} disagrees with ${kind} bump` }
  }
  return { legal: true, kind }
}

export interface VersionResolution {
  found: boolean
  compatible: boolean
  availableVersion?: string
}

/**
 * Resolve a tool by name and a requested (pinned) version against the live
 * manifest registry. Reports found + compatible so a caller pinned to an
 * incompatible MAJOR is told NO rather than silently handed a breaking contract.
 */
export function resolveToolVersion(name: string, requested: string): VersionResolution {
  const manifest = getManifest(name)
  if (!manifest) return { found: false, compatible: false }
  return {
    found: true,
    compatible: isCompatible(requested, manifest.version),
    availableVersion: manifest.version,
  }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const versionRequestSchema = z.union([
  z.object({ kind: z.literal('resolve'), name: z.string().min(1), requested: z.string().min(1) }),
  z.object({ kind: z.literal('compatible'), requested: z.string().min(1), available: z.string().min(1) }),
  z.object({ kind: z.literal('transition'), from: z.string().min(1), to: z.string().min(1), declaredBreaking: z.boolean() }),
])
export type VersionRequest = z.infer<typeof versionRequestSchema>

export type VersionResultValue =
  | { kind: 'resolve'; resolution: VersionResolution }
  | { kind: 'compatible'; compatible: boolean }
  | { kind: 'transition'; check: TransitionCheck }

export function queryVersioning(raw: unknown): ComponentResult<VersionResultValue> {
  const check = validateRequest(raw, versionRequestSchema, VERSIONING_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { versioning: VERSIONING_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'resolve':
      return completed({ kind: 'resolve', resolution: resolveToolVersion(q.name, q.requested) }, [], versions)
    case 'compatible':
      return completed({ kind: 'compatible', compatible: isCompatible(q.requested, q.available) }, [], versions)
    case 'transition':
      return completed({ kind: 'transition', check: checkTransition(q.from, q.to, q.declaredBreaking) }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
