/**
 * S4 — per-step verification. This module is the reason "done" cannot be talked
 * into existence.
 *
 * INVARIANT I1: only this file writes `fixed`, and only from a deterministic
 * re-measurement by the same pipeline that produced the finding. A model's
 * verdict can reach at most `fix_claimed`, which the end-of-campaign full
 * re-measure has to confirm (I3). There is no code path from "the agent said so"
 * to "fixed".
 *
 * The verification itself is set arithmetic: re-measure the batch's scopes, and
 * a finding is fixed exactly when its fingerprint is no longer present. Anything
 * we could not measure stays open — never "fixed by default".
 */
import {
  listFindings,
  markFixed,
  markStillPresent,
  markFixClaimed,
  stampFixApplied,
  type FindingRow,
} from '@/agent/lib/grind/finding-set'
import { adapterFor, isScopedVerifiable } from '@/agent/lib/grind/adapters'
import { loadFindingSet } from '@/agent/lib/grind/finding-set'
import { getStepMeta } from '@/agent/lib/grind/campaign'

export interface VerifyOutcome {
  verified: boolean
  fixed: string[]
  stillPresent: string[]
  unverifiable: string[]
  detail: string
}

/**
 * Pure decision: given what the re-measure observed, which findings are fixed?
 *
 * `measuredScopes` is the honesty boundary — a finding whose scope was not
 * measured is NOT fixed, it is unknown. That distinction is the whole point:
 * "we didn't look" must never be recorded as "it's gone".
 */
export function decideVerification(
  batch: FindingRow[],
  observed: { present: Set<string>; measuredScopes: string[] },
): { fixed: string[]; stillPresent: string[]; unverifiable: string[] } {
  const measured = new Set(observed.measuredScopes)
  const fixed: string[] = []
  const stillPresent: string[] = []
  const unverifiable: string[] = []

  for (const f of batch) {
    if (!measured.has(f.scope) || !isScopedVerifiable(f.code)) {
      unverifiable.push(f.id)
      continue
    }
    if (observed.present.has(f.fingerprint)) stillPresent.push(f.id)
    else fixed.push(f.id)
  }
  return { fixed, stillPresent, unverifiable }
}

/**
 * Verify one grind step's batch. Called by the driver AFTER a verify step's turn
 * completes — the turn's own narrative is irrelevant here; only the measurement
 * counts.
 */
export async function verifyStep(stepId: string, now = new Date()): Promise<VerifyOutcome> {
  const meta = await getStepMeta(stepId)
  if (!meta || (meta.kind !== 'verify' && meta.kind !== 'fix')) {
    return { verified: false, fixed: [], stillPresent: [], unverifiable: [], detail: 'not a verifiable step' }
  }

  const set = await loadFindingSet(meta.setId)
  if (!set) {
    return { verified: false, fixed: [], stillPresent: [], unverifiable: [], detail: 'finding set missing' }
  }

  const all = await listFindings(meta.setId)
  const batch = all.filter((f) => meta.fingerprints.includes(f.fingerprint))
  if (batch.length === 0) {
    return { verified: false, fixed: [], stillPresent: [], unverifiable: [], detail: 'batch is empty' }
  }

  const scopes = [...new Set(batch.map((f) => f.scope))]
  const observed = await adapterFor(set.source).reMeasure(set, scopes)
  const decision = decideVerification(batch, observed)

  await markFixed(decision.fixed, now)
  await markStillPresent(
    decision.stillPresent,
    'আবার মেপে দেখা গেল সমস্যাটা এখনো আছে — ঠিক হয়নি।',
    now,
  )
  // Unmeasurable ones keep whatever the fix step claimed; the final full
  // re-measure is what resolves them, and until then they block completion.
  await markFixClaimed(
    decision.unverifiable.filter((id) => {
      const f = batch.find((b) => b.id === id)
      return f?.status === 'in_progress'
    }),
    'এই ধাপে সরাসরি মাপা যায়নি — শেষের পূর্ণ মাপে যাচাই হবে।',
  )
  if (decision.fixed.length > 0) await stampFixApplied(meta.setId, now)

  return {
    verified: true,
    fixed: decision.fixed,
    stillPresent: decision.stillPresent,
    unverifiable: decision.unverifiable,
    detail:
      `${decision.fixed.length}টা সত্যিই ঠিক হয়েছে · ${decision.stillPresent.length}টা এখনো আছে` +
      (decision.unverifiable.length > 0 ? ` · ${decision.unverifiable.length}টা এখানে মাপা যায়নি` : ''),
  }
}
