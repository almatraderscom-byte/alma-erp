/**
 * SK-8 (item 1) — the owner-facing view of the approval ledger.
 *
 * The ledger shipped with no way to fill it. `approveSkill()` exists, but the
 * only caller would have been a script with database credentials, and an
 * approval written by a script is the one thing the ledger is not for: the
 * question it answers is "who said yes", so the answer has to be a person
 * clicking. This module is the read model behind that screen.
 *
 * It is deliberately pure — FS and KV stay in the route — because the
 * interesting logic is not "read a row", it is WHY a skill would or would not
 * run, and that is exactly the kind of thing that should be provable in a test
 * rather than discovered on his screen.
 *
 * The distinction this file exists to make: `approved` is not the same as
 * `runs`. A draft skill can be approved and still never be offered; `alma-base`
 * is approved-shaped but `implicit: false`, so it is inherited and never
 * selected. Showing a green tick next to a skill that can never run would be a
 * lie of exactly the kind SK-8 was built to stop.
 */
import { approvalState, mayRun, type SkillApproval, type SkillApprovalLedger, type SkillApprovalState } from '@/agent/lib/skill-engine/provenance'

/** The minimum a caller must know about a skill on disk. */
export interface SkillApprovalInput {
  name: string
  version: string
  status: string
  /** U8 — false means it can never be auto-selected (base layers, named-only skills). */
  implicit: boolean
  isolation: 'inline' | 'subagent'
  hash: string
}

/** Why a skill will not run this turn, independent of approval. */
export type SkillBlockedBy = 'draft' | 'never-auto' | 'approval' | null

export interface SkillApprovalRow extends SkillApprovalInput {
  /** First 12 hex chars — enough to compare two builds by eye, short enough to read. */
  hashShort: string
  state: SkillApprovalState
  /** Would this skill be offered to the router right now, with the gate as it is? */
  wouldRun: boolean
  blockedBy: SkillBlockedBy
  approval: SkillApproval | null
}

export interface SkillApprovalView {
  gateOn: boolean
  engineEnabled: boolean
  rows: SkillApprovalRow[]
  /** Counts the owner actually asks for: how many are live, how many need a decision. */
  summary: { total: number; live: number; needsApproval: number; revoked: number }
}

/** A skill the loader would offer at all — `discoverSkills` serves these statuses. */
function selectableStatus(status: string): boolean {
  return status === 'active' || status === 'canary'
}

export function buildApprovalView(
  skills: SkillApprovalInput[],
  ledger: SkillApprovalLedger,
  opts: { gateOn: boolean; engineEnabled: boolean },
): SkillApprovalView {
  const rows: SkillApprovalRow[] = skills.map((s) => {
    const state = approvalState({ name: s.name, version: s.version, hash: s.hash }, ledger)
    // Order matters: report the FIRST reason it cannot run, not the most
    // alarming one. A draft skill held back by the gate is still just a draft,
    // and saying "approval" there would send him to approve something that
    // would change nothing.
    const blockedBy: SkillBlockedBy = !selectableStatus(s.status)
      ? 'draft'
      : !s.implicit
        ? 'never-auto'
        : !mayRun(state, opts.gateOn)
          ? 'approval'
          : null
    return {
      ...s,
      hashShort: s.hash.slice(0, 12),
      state,
      wouldRun: opts.engineEnabled && blockedBy === null,
      blockedBy,
      approval: ledger[s.name] ?? null,
    }
  })

  // Selectable skills first (those are the ones a decision matters for), then
  // by name so the list does not reshuffle between reloads.
  rows.sort((a, b) => {
    const rank = (r: SkillApprovalRow) => (selectableStatus(r.status) ? 0 : 1)
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  })

  return {
    gateOn: opts.gateOn,
    engineEnabled: opts.engineEnabled,
    rows,
    summary: {
      total: rows.length,
      live: rows.filter((r) => r.wouldRun).length,
      // What turning the gate on would break RIGHT NOW: selectable, auto-usable
      // skills that are not approved. This number is the whole point of the
      // screen — the gate was left off because nobody could see it.
      needsApproval: rows.filter(
        (r) => selectableStatus(r.status) && r.implicit && r.state !== 'approved',
      ).length,
      revoked: rows.filter((r) => r.state === 'revoked').length,
    },
  }
}
