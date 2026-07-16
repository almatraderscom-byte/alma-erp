/**
 * Phase 44 — CRO briefs: analytics-backed landing/checkout improvement
 * proposals. A brief NEVER edits the live site — it describes evidence,
 * the exact change, expected impact as a range, the accessibility/mobile/
 * performance checklist, and a rollback plan. Implementation later goes
 * through a scoped branch + preview + owner merge (Phase 47 release loop).
 */

export interface CroEvidence {
  source: string // e.g. 'GA4', 'GSC', 'session recording', 'funnel report'
  metric: string
  value: number
  note?: string
}

export interface CroBrief {
  page: string
  problem: string
  evidence: CroEvidence[]
  hypothesis: string
  change: string
  /** Expected impact as an honest range on a named metric. */
  expectedImpact: { metric: string; lowPct: number; highPct: number }
  checklist: {
    accessibility: boolean
    mobile: boolean
    performance: boolean
  }
  rollbackPlan: string
  experimentId?: string | null
}

export interface CroBriefValidation {
  ok: boolean
  errors: string[]
}

/** A CRO brief without evidence or rollback is an opinion, not a brief. */
export function validateCroBrief(brief: Partial<CroBrief> | null | undefined): CroBriefValidation {
  const errors: string[] = []
  if (!brief) return { ok: false, errors: ['brief missing'] }
  if (!brief.page?.trim()) errors.push('page (URL/path) required')
  if (!brief.problem?.trim()) errors.push('problem statement required')
  if (!brief.evidence || brief.evidence.length === 0) errors.push('at least one evidence item required — no evidence, no change')
  else {
    for (const [i, e] of brief.evidence.entries()) {
      if (!e.source?.trim() || !e.metric?.trim() || !Number.isFinite(e.value)) errors.push(`evidence[${i}] needs source+metric+numeric value`)
    }
  }
  if (!brief.hypothesis?.trim()) errors.push('hypothesis required')
  if (!brief.change?.trim()) errors.push('exact change description required')
  const imp = brief.expectedImpact
  if (!imp || !imp.metric?.trim() || !Number.isFinite(imp.lowPct) || !Number.isFinite(imp.highPct)) {
    errors.push('expectedImpact range (metric, lowPct, highPct) required')
  } else if (imp.lowPct > imp.highPct) {
    errors.push('expectedImpact lowPct must be ≤ highPct')
  }
  if (!brief.checklist) errors.push('accessibility/mobile/performance checklist required')
  if (!brief.rollbackPlan?.trim()) errors.push('rollback plan required')
  return { ok: errors.length === 0, errors }
}

/** Owner-readable Bangla-lite summary for the approval card. */
export function formatCroBrief(brief: CroBrief): string {
  const lines = [
    `🔧 *CRO Brief — ${brief.page}*`,
    '',
    `সমস্যা: ${brief.problem}`,
    `প্রমাণ: ${brief.evidence.map((e) => `${e.source} ${e.metric}=${e.value}`).join('; ')}`,
    `হাইপোথিসিস: ${brief.hypothesis}`,
    `পরিবর্তন: ${brief.change}`,
    `প্রত্যাশিত প্রভাব: ${brief.expectedImpact.metric} ${brief.expectedImpact.lowPct}–${brief.expectedImpact.highPct}%`,
    `চেকলিস্ট: a11y ${brief.checklist.accessibility ? '✅' : '❌'} · mobile ${brief.checklist.mobile ? '✅' : '❌'} · perf ${brief.checklist.performance ? '✅' : '❌'}`,
    `রোলব্যাক: ${brief.rollbackPlan}`,
  ]
  if (brief.experimentId) lines.push(`Experiment: ${brief.experimentId}`)
  lines.push('', '_কোনো live-site edit নয় — implementation হবে scoped branch + preview + owner merge দিয়ে।_')
  return lines.join('\n')
}
