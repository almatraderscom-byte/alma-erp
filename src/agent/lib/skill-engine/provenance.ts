/**
 * SK-8 — which version of a skill ran, who approved it, and how to take it back.
 *
 * This is the one enterprise gap the 2026-07-27 research review named that this
 * codebase did not have. The eval harness (SK-1), the tool allowlist (SK-4) and
 * the selection trace (SK-3) all existed; provenance did not. A buyer's question
 * is never "how many skills do you have" — it is "who approved the thing that
 * touched my data, and can you take it back".
 *
 * Three properties, and each is enforced rather than documented:
 *
 *  1. **VERSION + CONTENT HASH.** `version` in a manifest is a promise a human
 *     makes; the hash is what actually ran. Both are recorded, so "we approved
 *     2.1.0" and "2.1.0 was silently edited afterwards" are distinguishable.
 *  2. **APPROVAL RECORD.** Who approved which version, when, with a note. A
 *     skill nobody approved is not a skill the business agreed to run.
 *  3. **ROLLBACK.** Revoking an approval takes a skill out of service on the
 *     next turn, with no deploy. This is the honest form of runtime rollback:
 *     restoring older FILE content is a git revert and always will be, but
 *     stopping the current version instantly is what an incident needs.
 *
 * Deliberately a pure module over an injected ledger — the store is small, and
 * keeping the rules testable without a database is what let the SK-4 allowlist
 * bugs be found in tests rather than on his screen.
 */
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

/** Files whose contents define "the skill" for approval purposes. */
export const HASHED_FILES = ['manifest.json', 'SKILL.md', 'SYSTEM.md'] as const

export interface SkillApproval {
  /** The manifest version the approval was granted for. */
  version: string
  /** Content hash at the moment of approval — this is what was really approved. */
  hash: string
  /** Who said yes. `owner` for Boss; a name for anyone else. */
  approvedBy: string
  /** ISO timestamp. */
  approvedAt: string
  note?: string
  /** Set when the approval was withdrawn — the skill stops running immediately. */
  revokedAt?: string
  revokedReason?: string
}

export type SkillApprovalLedger = Record<string, SkillApproval>

/**
 * `approved`  — this exact content was approved and not revoked.
 * `changed`   — approved once, but the files differ from what was approved.
 * `revoked`   — approval withdrawn; must not run.
 * `unapproved`— never approved.
 */
export type SkillApprovalState = 'approved' | 'changed' | 'revoked' | 'unapproved'

/**
 * Hash of the skill's defining files. Missing files hash as empty rather than
 * throwing, so adding a `SYSTEM.md` to a skill that had none is a legible
 * CHANGE (which re-requires approval) instead of a crash.
 */
export async function computeSkillHash(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const file of HASHED_FILES) {
    let content = ''
    try {
      content = await fs.readFile(path.join(dir, file), 'utf8')
    } catch {
      content = ''
    }
    // The filename is hashed too, so moving text between files changes the hash.
    h.update(file).update('\0').update(content).update('\0')
  }
  return h.digest('hex')
}

/** What the ledger says about a skill as it exists on disk right now. */
export function approvalState(
  skill: { name: string; version: string; hash: string },
  ledger: SkillApprovalLedger,
): SkillApprovalState {
  const record = ledger[skill.name]
  if (!record) return 'unapproved'
  if (record.revokedAt) return 'revoked'
  // The HASH decides, not the version string. A version bumped without an
  // approval is `changed`; so is content edited without bumping the version —
  // and the second is the one that would otherwise go unnoticed.
  if (record.hash !== skill.hash) return 'changed'
  return 'approved'
}

/**
 * May this skill run? Only `approved` passes when the gate is on.
 *
 * With the gate OFF the answer is always yes and the state is still computed,
 * so the ledger can be populated and observed on real traffic before it starts
 * refusing anything. That order is deliberate: a gate switched on blind would
 * silently disable every skill at once.
 */
export function mayRun(state: SkillApprovalState, gateOn: boolean): boolean {
  if (!gateOn) return true
  return state === 'approved'
}

/** One line for the owner, in his language, when a skill is held back. */
export function heldBackReason(name: string, state: SkillApprovalState): string {
  switch (state) {
    case 'changed':
      return `\`${name}\` skill-টা অনুমোদনের পর বদলানো হয়েছে — তাই এই টার্নে চালানো হয়নি। নতুন version অনুমোদন করলে আবার চলবে।`
    case 'revoked':
      return `\`${name}\` skill-এর অনুমোদন তুলে নেওয়া হয়েছে — তাই এটা চলছে না।`
    case 'unapproved':
      return `\`${name}\` skill-টা এখনো কেউ অনুমোদন করেনি — তাই এই টার্নে চালানো হয়নি।`
    default:
      return ''
  }
}

/** Grant approval for exactly the content that is on disk now. */
export function grant(
  ledger: SkillApprovalLedger,
  input: { name: string; version: string; hash: string; approvedBy: string; at: string; note?: string },
): SkillApprovalLedger {
  return {
    ...ledger,
    [input.name]: {
      version: input.version,
      hash: input.hash,
      approvedBy: input.approvedBy,
      approvedAt: input.at,
      ...(input.note ? { note: input.note } : {}),
    },
  }
}

/**
 * Withdraw an approval — the runtime rollback. The record is KEPT, with the
 * reason, rather than deleted: an audit trail that can be erased is not one.
 * Re-approving later overwrites it cleanly via `grant`.
 */
export function revoke(
  ledger: SkillApprovalLedger,
  input: { name: string; at: string; reason?: string },
): SkillApprovalLedger {
  const record = ledger[input.name]
  if (!record) return ledger
  return {
    ...ledger,
    [input.name]: {
      ...record,
      revokedAt: input.at,
      ...(input.reason ? { revokedReason: input.reason } : {}),
    },
  }
}
