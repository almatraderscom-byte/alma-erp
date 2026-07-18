/**
 * Skill Engine V2 — package format types (Phase B1 foundation).
 *
 * Design source: docs/agent-grok-architecture-roadmap.md → "Skill Engine V2".
 * A SKILL is reusable procedure + domain knowledge the head loads ON DEMAND
 * (progressive disclosure), unlike the 5 hard-coded skill packs. A skill makes the
 * agent more COMPETENT; it does NOT grant a capability — only approved Alma tools
 * read or mutate data. Auth, approvals, spend limits, secrets stay in code, never
 * in a skill (see the roadmap's "keep in code, never in a downloadable skill" list).
 *
 * This file is pure types + validation shapes. It is deliberately NOT wired into the
 * live turn yet — the discovery/selection/activation pipeline (loader.ts) and the
 * completion-gate reuse (existing skill-packs/runner.ts) come next, then head wiring.
 */

/** Lifecycle status — a skill only reaches `active` after evals + owner review. */
export type SkillStatus = 'draft' | 'reviewed' | 'canary' | 'active' | 'retired'

/** Coarse risk classification — drives how much scrutiny activation needs. */
export type SkillRiskTier = 'low' | 'medium' | 'high'

/**
 * manifest.json — the structured contract. Kept as JSON (not YAML) so no parser
 * dependency is added. `requiredCapabilities` names Alma TOOL/GROUP names only; the
 * loader validates every one against the live registry (a skill can never invent a
 * handler). `requiredSecrets` lists NAMES only — never values.
 */
export interface SkillManifest {
  name: string
  description: string
  version: string
  publisher: string
  license: string
  /** Provenance for imported skills; empty for Alma-native ones. */
  sourceCommit?: string
  contentHash?: string

  businessScopes: string[]
  riskTier: SkillRiskTier
  /** Alma capability (tool/group) names this skill is allowed to use. */
  requiredCapabilities: string[]
  /** Secret NAMES the skill's procedure expects to exist (never values). */
  requiredSecrets?: string[]

  allowedDomains?: string[]
  networkPolicy?: 'none' | 'allowlist' | 'open'
  writePolicy?: 'none' | 'staged' | 'owner_gated'
  approvalPolicy?: 'inherit' | 'always' | 'never'

  entryWorkflow?: string
  maxTools?: number
  maxSteps?: number
  maxCostTaka?: number

  evalSuite?: string
  minimumPassRate?: number
  status: SkillStatus
}

/**
 * The lightweight metadata loaded at DISCOVERY — only what selection needs. The
 * roadmap budget is ~100 tokens per skill at discovery, so keep this small.
 */
export interface SkillMetadata {
  name: string
  description: string
  version: string
  riskTier: SkillRiskTier
  status: SkillStatus
  requiredCapabilities: string[]
  /** Extra keyword hints for routing (from frontmatter `keywords:`), optional. */
  keywords: string[]
  /** Absolute path to the skill package directory. */
  dir: string
}

/**
 * A fully ACTIVATED skill — metadata + the SKILL.md instruction body, loaded only
 * once selection picks it. The body stays under ~5k tokens (roadmap gate).
 */
export interface ActivatedSkill {
  metadata: SkillMetadata
  manifest: SkillManifest
  /** The SKILL.md body (the actual procedure the head follows). */
  instructions: string
}

/** Result of a discovery scan — the metadata index the selector routes over. */
export interface SkillIndex {
  skills: SkillMetadata[]
  /** Non-fatal problems found while scanning (bad manifest, unknown capability). */
  warnings: string[]
}
