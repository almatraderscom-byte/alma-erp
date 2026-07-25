/**
 * S5 — regression guard. "No fix that creates a new problem" (Boss's rule)
 * becomes a control signal instead of a paragraph in a report.
 *
 * The before/after computation already existed — `⚠️ নতুন সমস্যা` in the client
 * report. It was purely descriptive: the engine happily carried on while its own
 * fixes broke other things. Here the SAME computation (diffAudits, shared with
 * the report so the two can never disagree) drives behaviour:
 *
 *  - anything introduced becomes a NEW finding in the campaign, flagged
 *    `introduced` → the completion arithmetic (I3) blocks on it;
 *  - the suspect batch is marked `regressed`, so it is re-diagnosed rather than
 *    quietly re-fixed;
 *  - a family that regresses twice loses its unattended approval — Boss decides
 *    again before it touches anything else;
 *  - three regressions in one campaign HALT it. Three is not bad luck; it means
 *    the diagnosis method is wrong, and grinding on would only break more.
 */
import { diffAudits, type AuditJson } from '@/agent/lib/seo-report'
import {
  bumpRegressionCount,
  ingestFindings,
  listFindings,
  markRegressed,
  setSetStatus,
  type FindingSetRow,
} from '@/agent/lib/grind/finding-set'
import { revokeFamilyGrant } from '@/agent/lib/grind/family-approval'

/** Regressions in ONE campaign before we stop and think instead of grinding. */
export const HALT_AFTER_REGRESSIONS = 3
/** Regressions in ONE family before its unattended approval is revoked. */
export const REVOKE_FAMILY_AFTER = 2

export interface RegressionReport {
  introduced: number
  regressedBatch: string[]
  familyRevoked: string | null
  halted: boolean
  detail: string
}

/**
 * Compare a fresh measurement against the campaign's baseline and act on what
 * we broke. `batchFamily`/`batchFingerprints` name the batch under suspicion —
 * the work that happened since the last clean sweep.
 */
export async function guardRegressions(input: {
  set: FindingSetRow
  baseline: AuditJson
  after: AuditJson
  suspectFamily?: string | null
  suspectFingerprints?: string[]
  now?: Date
}): Promise<RegressionReport> {
  const now = input.now ?? new Date()
  const { introduced } = diffAudits(input.baseline, input.after)

  if (introduced.length === 0) {
    return { introduced: 0, regressedBatch: [], familyRevoked: null, halted: false, detail: 'নতুন কোনো সমস্যা তৈরি হয়নি।' }
  }

  // 1. The new problems join the campaign — they are now work, not a footnote.
  await ingestFindings(
    input.set.id,
    introduced.map((i) => ({
      scope: i.scope,
      code: i.code,
      severity: i.severity,
      detail: i.detail,
      family: i.code,
    })),
    { introduced: true, now },
  )

  // 2. The suspect batch is marked regressed so it gets re-diagnosed, not
  //    re-attempted with the same (evidently wrong) root cause.
  const suspects = input.suspectFingerprints ?? []
  const rows = await listFindings(input.set.id)
  const suspectIds = rows.filter((r) => suspects.includes(r.fingerprint)).map((r) => r.id)
  await markRegressed(suspectIds, `এই ব্যাচের পরে ${introduced.length}টা নতুন সমস্যা এসেছে।`, now)

  // 3. Count the regression at campaign level; act on the thresholds.
  const count = await bumpRegressionCount(input.set.id)

  let familyRevoked: string | null = null
  if (input.suspectFamily) {
    const familyRegressions = await countFamilyRegressions(input.set.id, input.suspectFamily)
    if (familyRegressions >= REVOKE_FAMILY_AFTER) {
      await revokeFamilyGrant(input.set.id, input.suspectFamily)
      familyRevoked = input.suspectFamily
    }
  }

  const halted = count >= HALT_AFTER_REGRESSIONS
  if (halted) {
    await setSetStatus(
      input.set.id,
      'halted',
      `${count} বার ফিক্স করতে গিয়ে নতুন সমস্যা তৈরি হয়েছে — পদ্ধতিটাই ভুল, তাই থামালাম।`,
    )
  }

  return {
    introduced: introduced.length,
    regressedBatch: suspects,
    familyRevoked,
    halted,
    detail:
      `${introduced.length}টা নতুন সমস্যা তৈরি হয়েছে (মোট ${count} বার)।`
      + (familyRevoked ? ` "${familyRevoked}" family-র স্বয়ংক্রিয় অনুমতি বাতিল করলাম।` : '')
      + (halted ? ' ক্যাম্পেইন থামালাম — Boss-কে জানাতে হবে।' : ''),
  }
}

/** How many findings of this family are currently marked regressed. */
async function countFamilyRegressions(setId: string, family: string): Promise<number> {
  const rows = await listFindings(setId, { family, status: 'regressed' })
  return rows.length
}
