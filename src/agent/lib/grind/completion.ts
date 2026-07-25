/**
 * S7 / INVARIANT I3 — completion is ARITHMETIC.
 *
 * The existing whole-plan gate asks a model, with `max_tokens: 120`, over a
 * 6000-character truncated prompt, whether the work is done. Past ~20 steps that
 * is arithmetically incapable of seeing the work it is judging — and it is a
 * prompt, so it can be talked past.
 *
 * A campaign is done when, and only when, ALL of these hold:
 *   open === 0                 nothing left unfixed
 *   inProgress === 0           nothing still being worked
 *   claimedOnly === 0          nothing resting on the agent's word alone
 *   regressed === 0            nothing we broke and left broken
 *   needsRediagnosis === 0     nothing whose cause we never actually found
 *   introduced === 0           no new problem we created is still open
 *   reMeasuredAt > lastFixAt   the last measurement is NEWER than the last fix
 *
 * There is no prompt here, no truncation, and nothing to argue with. Zero tokens.
 */
import { listFindings, loadFindingSet, tallyFindings, type GrindTally } from '@/agent/lib/grind/finding-set'

export interface GrindCompletion {
  done: boolean
  tally: GrindTally
  /** Bangla, owner-facing — what is standing between us and done. */
  reason: string
  blockers: string[]
  /** Newest re-measurement across the campaign (I3's freshness test). */
  reMeasuredAt: Date | null
  lastFixAt: Date | null
}

export async function runGrindCompletionGate(setId: string): Promise<GrindCompletion> {
  const set = await loadFindingSet(setId)
  const rows = await listFindings(setId)
  const tally = tallyFindings(rows)

  const reMeasuredAt = rows.reduce<Date | null>((max, r) => {
    if (!r.reMeasuredAt) return max
    return !max || r.reMeasuredAt > max ? r.reMeasuredAt : max
  }, null)
  const lastFixAt = set?.lastFixAt ?? null

  const blockers: string[] = []
  if (tally.open > 0) blockers.push(`${tally.open}টা এখনো ঠিক হয়নি`)
  if (tally.inProgress > 0) blockers.push(`${tally.inProgress}টা চলছে`)
  if (tally.claimedOnly > 0) blockers.push(`${tally.claimedOnly}টা "ঠিক করেছি" বলা হয়েছে কিন্তু মেপে দেখা হয়নি`)
  if (tally.regressed > 0) blockers.push(`${tally.regressed}টা আবার ভেঙেছে`)
  if (tally.needsRediagnosis > 0) blockers.push(`${tally.needsRediagnosis}টার আসল কারণ আবার বের করতে হবে`)
  if (tally.introduced > 0) blockers.push(`${tally.introduced}টা নতুন সমস্যা আমরা নিজেরাই তৈরি করেছি`)

  // Freshness: a fix applied AFTER the last measurement means the current
  // numbers describe a site that no longer exists. Measure again before
  // claiming anything.
  if (lastFixAt && (!reMeasuredAt || reMeasuredAt <= lastFixAt)) {
    blockers.push('শেষ ফিক্সের পরে আর মাপা হয়নি — আবার মেপে তবেই শেষ বলব')
  }

  const done = blockers.length === 0 && tally.total > 0
  return {
    done,
    tally,
    blockers,
    reMeasuredAt,
    lastFixAt,
    reason: done
      ? `${tally.total}টার মধ্যে ${tally.fixed}টা মেপে নিশ্চিত হয়েছে, ${tally.wontFix}টা ইচ্ছাকৃতভাবে বাদ — কাজ শেষ।`
      : blockers.join(' · '),
  }
}

/** One-line progress for the owner: "২৪৬ টার মধ্যে ১৮৩ টা ঠিক হয়েছে · ০ নতুন সমস্যা". */
export function grindHeadline(tally: GrindTally): string {
  const bn = (n: number) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)])
  const parts = [`${bn(tally.total)} টার মধ্যে ${bn(tally.fixed)} টা ঠিক হয়েছে`]
  if (tally.claimedOnly > 0) parts.push(`${bn(tally.claimedOnly)} টা যাচাই বাকি`)
  if (tally.regressed > 0) parts.push(`${bn(tally.regressed)} টা আবার ভেঙেছে`)
  parts.push(`${bn(tally.introduced)} নতুন সমস্যা`)
  return parts.join(' · ')
}
