/**
 * Roadmap 1 Phase 36 — response plan BEFORE wording:
 * acknowledge → answer/action → evidence → next commitment, sections omitted
 * when unnecessary; deterministic anti-repetition variation (turn-count
 * rotation, zero randomness — no personality drift); uncertainty framing
 * (fact / inference / recommendation) and direct repair on corrections.
 */
import type { InteractionPolicy } from '@/agent/lib/interaction-policy'
import type { InteractionState } from '@/agent/lib/interaction-state'
import { NON_DECEPTION_NOTE, OWNER_ADDRESS } from '@/agent/lib/interaction-policy'

export type ResponseSection = 'acknowledge' | 'answer' | 'evidence' | 'commitment' | 'repair'

export interface ResponsePlan {
  sections: ResponseSection[]
  tone: InteractionPolicy['tone']
  maxLines: number
  /** Deterministic opener variant index (anti-repetition). */
  openerVariant: number
}

/** Small rotating opener pools per tone — variation without drift. */
const OPENERS: Record<string, string[]> = {
  warm_listen: ['Boss, আমি আছি — শুনছি।', 'Boss, বলুন — আমি পুরোটা শুনছি।', 'Boss, আপনার পাশে আছি।'],
  calm_support: ['Boss, আমি এখানে আছি — একসাথে দেখি।', 'Boss, আগে একটা লম্বা শ্বাস — আমি আছি।'],
  brief: ['Boss —', 'Boss, এক নজরে —'],
  direct_work: ['Boss,', 'ঠিক আছে Boss —', 'Boss, দেখে নিলাম —'],
  mentor: ['Boss, চলুন গুছিয়ে ভাবি —', 'Boss, দুটো দিক দেখা দরকার —'],
}

export function planResponse(
  state: InteractionState,
  policy: InteractionPolicy,
  ctx: { turnCount: number; hasEvidence: boolean; willCommit: boolean },
): ResponsePlan {
  const sections: ResponseSection[] = []
  if (state.repairNeeded) sections.push('repair')
  if (policy.mustAcknowledgeFeeling) sections.push('acknowledge')
  sections.push('answer')
  if (ctx.hasEvidence && policy.mode !== 'personal_listen' && policy.mode !== 'crisis_safety') sections.push('evidence')
  if (ctx.willCommit && policy.mode === 'work') sections.push('commitment')
  const pool = OPENERS[policy.tone] ?? OPENERS.direct_work
  return {
    sections,
    tone: policy.tone,
    maxLines: policy.maxLines,
    openerVariant: Math.abs(ctx.turnCount) % pool.length,
  }
}

/** Deterministic opener for the variant (exported for tests + the directive). */
export function openerFor(plan: ResponsePlan): string {
  const pool = OPENERS[plan.tone] ?? OPENERS.direct_work
  return pool[plan.openerVariant % pool.length]
}

/**
 * The per-turn Bangla directive injected into the volatile context — the
 * plan as INSTRUCTIONS, so every head model follows the same behaviour
 * contract without prompt drift.
 */
export function buildResponseDirective(state: InteractionState, policy: InteractionPolicy, plan: ResponsePlan): string {
  const lines: string[] = [
    `[INTERACTION CONTRACT — mode: ${policy.mode}]`,
    `• সম্বোধন: শুধুই "${OWNER_ADDRESS}"। ${NON_DECEPTION_NOTE}`,
    `• উত্তরের কাঠামো (ক্রম ধরে, অপ্রয়োজনীয় অংশ বাদ): ${plan.sections.join(' → ')}। সর্বোচ্চ ~${plan.maxLines} লাইন।`,
    `• শুরুর ধরন (হুবহু নয়, এই আবহে): "${openerFor(plan)}" — আগের টার্নের শুরুর বাক্য হুবহু আবার ব্যবহার নিষেধ।`,
  ]
  if (state.repairNeeded) {
    lines.push('• Boss একটা ভুল ধরিয়ে দিয়েছেন: প্রথম লাইনেই সরাসরি স্বীকার + ঠিক করা — কোনো অজুহাত বা ঘুরিয়ে বলা নয়।')
  }
  if (policy.mustAcknowledgeFeeling) {
    lines.push('• আগে অনুভূতিটা স্বীকার করো (এক লাইন), তারপর বাকিটা।')
  }
  if (!policy.allowWorkPivot) {
    lines.push('• Boss না চাইলে নিজে থেকে ব্যবসার চলমান কাজ টেনে আনবে না।')
  }
  lines.push(
    '• অনিশ্চিত হলে স্পষ্ট বলো কোনটা তথ্য (tool থেকে দেখা), কোনটা অনুমান, কোনটা পরামর্শ — অনুমানকে তথ্যের মতো বলা নিষেধ।',
    '• ভবিষ্যতের কাজের কথা দিলে ওই টার্নেই durable কমিটমেন্ট থাকতে হবে (task/card/reminder/focus) — নাহলে কথা দিও না, এখনই করো বা সত্যটা বলো।',
  )
  return lines.join('\n')
}
