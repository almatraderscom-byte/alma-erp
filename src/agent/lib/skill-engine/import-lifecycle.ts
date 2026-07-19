/**
 * Skill Engine V2 — imported-skill lifecycle state machine (Phase B4, pure logic).
 *
 * An imported GitHub skill moves draft → reviewed → canary → active, can be retired
 * from anywhere, and a `block`-verdict import is quarantined and can NEVER go live.
 * Rollback promotes the previously-active version back and retires the current one.
 *
 * Pure + synchronous → fully unit-testable, no DB. The store (import-store.ts) applies
 * these rules against Postgres.
 */
import type { ImportScanResult } from '@/agent/lib/skill-engine/import-scan'

export type ImportedSkillStatus = 'blocked' | 'draft' | 'reviewed' | 'canary' | 'active' | 'retired'

/** Allowed forward transitions. `retired` is reachable from any live state; `blocked`
 *  and `retired` are terminal (no promotion out). */
const FORWARD: Record<ImportedSkillStatus, ImportedSkillStatus[]> = {
  blocked: [],
  draft: ['reviewed', 'retired'],
  reviewed: ['canary', 'retired'],
  canary: ['active', 'retired'],
  active: ['retired'],
  retired: [],
}

export function canTransition(from: ImportedSkillStatus, to: ImportedSkillStatus): boolean {
  return FORWARD[from]?.includes(to) ?? false
}

/** The status a fresh scan result should be recorded at. A blocked verdict is
 *  quarantined; everything else enters as draft (never straight to active). */
export function initialStatusFor(scan: ImportScanResult): ImportedSkillStatus {
  return scan.verdict === 'block' ? 'blocked' : 'draft'
}

export class LifecycleError extends Error {}

/**
 * Guard a promotion. Throws LifecycleError when:
 *  - the target isn't a legal next step from the current status, OR
 *  - the import's scan verdict is `block` (quarantined imports never advance).
 */
export function assertPromotion(
  from: ImportedSkillStatus,
  to: ImportedSkillStatus,
  verdict: ImportScanResult['verdict'],
): void {
  if (verdict === 'block') {
    throw new LifecycleError('a blocked import can never be promoted — re-import a clean version')
  }
  if (!canTransition(from, to)) {
    throw new LifecycleError(`illegal transition ${from} → ${to}`)
  }
}

/** Is this status one where the skill is actually offered to the head? */
export function isLiveStatus(status: ImportedSkillStatus): boolean {
  return status === 'canary' || status === 'active'
}
