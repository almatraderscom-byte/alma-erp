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

  // ── Format v2 (2026-07-26). All optional, so every v1 skill stays valid. ──

  /** Inherit the shared ALMA invariants instead of copying them into 40 files. */
  extends?: string
  /**
   * `subagent` runs the job with its own lean system prompt (alma-base +
   * SYSTEM.md + SKILL.md) and this skill's tool allowlist — the isolation the
   * owner asked for. `inline` keeps it in the current conversation.
   */
  isolation?: 'inline' | 'subagent'
  /**
   * U8. `false` = never auto-selected; Boss must name it. Money movement and
   * publishing belong here. Defaults to true when absent.
   */
  implicit?: boolean
  /** The negative half of routing — "use X instead when…". Feeds the tie-break. */
  whenNotToUse?: string
  /**
   * U2. What must exist for the skill to work at all, checked BEFORE step 0 by
   * the capability preflight. The alt-text job burned 15 steps discovering a
   * missing WEBSITE_SUPABASE_URL one tool at a time; a declared dependency turns
   * that into one honest sentence.
   */
  dependencies?: {
    env?: string[]
    capability?: string[]
  }
  /** U2. The deliverable's shape — checkable, unlike "give a good report". */
  outputContract?: {
    kind: string
    mustInclude?: string[]
  }
  /** U2. Where the skill must stop and ask Boss rather than guess. */
  stopConditions?: string[]
  /** Machine-checkable completion, fed to the existing skill-pack gate. */
  done?: Array<{ tool?: string; check?: string }>
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
  /** U8 — false means it can never be auto-selected. Defaults true. */
  implicit: boolean
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
  /**
   * SK-7. The skill's OWN system prompt (`SYSTEM.md`) — role, tone, hard limits.
   * This is the half of the owner's ask that a skill file alone cannot give: it
   * only means anything when `isolation: 'subagent'` makes it REPLACE the general
   * behavioural prompt instead of being appended to it. Empty when the package
   * carries no SYSTEM.md (every v1 skill).
   */
  systemPrompt: string
  /**
   * SK-7. The resolved `extends:` base body (`alma-base/SKILL.md`) — the ALMA
   * invariants written once. An isolated turn drops the big prompt, so these
   * must ride along or the invariants would leave with it.
   */
  baseInstructions: string
}

/** Result of a discovery scan — the metadata index the selector routes over. */
export interface SkillIndex {
  skills: SkillMetadata[]
  /** Non-fatal problems found while scanning (bad manifest, unknown capability). */
  warnings: string[]
}
