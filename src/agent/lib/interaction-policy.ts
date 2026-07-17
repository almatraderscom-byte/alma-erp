/**
 * Roadmap 1 Phase 36 — interaction policy: what each mode ALLOWS, as code.
 * The prompt shapes tone; the policy shapes capability (tools/pivot) and the
 * commitment ledger keeps promises structural.
 */
import type { InteractionMode, InteractionState } from '@/agent/lib/interaction-state'

/** ONE owner-address contract — the single source every layer asserts against. */
export const OWNER_ADDRESS = 'Boss'
export const OWNER_ADDRESS_BANNED = ['Sir', 'স্যার', 'sir']

/** Non-deception contract: friendly AI assistant, never a human/staff/user. */
export const NON_DECEPTION_NOTE =
  'তুমি Boss-এর AI অ্যাসিস্ট্যান্ট — কখনো নিজেকে মানুষ, স্টাফ সদস্য বা কোনো প্ল্যাটফর্মের সাধারণ ইউজার হিসেবে পরিচয় দেবে না; জিজ্ঞেস করলে সত্যটা সহজভাবে বলবে।'

export interface InteractionPolicy {
  mode: InteractionMode
  /** Business tools available this turn (listen/crisis strip them). */
  allowTools: boolean
  /** May the agent bring up in-flight business work uninvited? */
  allowWorkPivot: boolean
  tone: 'warm_listen' | 'calm_support' | 'direct_work' | 'brief' | 'mentor'
  /** Soft cap the response planner passes to the style layer. */
  maxLines: number
  mustAcknowledgeFeeling: boolean
}

export function policyForState(state: InteractionState): InteractionPolicy {
  switch (state.mode) {
    case 'crisis_safety':
      return { mode: state.mode, allowTools: false, allowWorkPivot: false, tone: 'calm_support', maxLines: 8, mustAcknowledgeFeeling: true }
    case 'personal_listen':
      return { mode: state.mode, allowTools: false, allowWorkPivot: false, tone: 'warm_listen', maxLines: 6, mustAcknowledgeFeeling: true }
    case 'coaching':
      return { mode: state.mode, allowTools: true, allowWorkPivot: false, tone: 'mentor', maxLines: 12, mustAcknowledgeFeeling: false }
    case 'decision_support':
      return { mode: state.mode, allowTools: true, allowWorkPivot: false, tone: 'mentor', maxLines: 12, mustAcknowledgeFeeling: false }
    case 'concise_status':
      return { mode: state.mode, allowTools: true, allowWorkPivot: false, tone: 'brief', maxLines: 4, mustAcknowledgeFeeling: false }
    case 'teaching':
      return { mode: state.mode, allowTools: true, allowWorkPivot: false, tone: 'direct_work', maxLines: 6, mustAcknowledgeFeeling: false }
    case 'work':
    default:
      return {
        mode: 'work', allowTools: true, allowWorkPivot: true, tone: state.detail === 'short' ? 'brief' : 'direct_work',
        maxLines: state.detail === 'short' ? 4 : state.detail === 'detailed' ? 20 : 10,
        mustAcknowledgeFeeling: state.emotion === 'low' || state.emotion === 'anxious',
      }
  }
}

// ── Commitment ledger (roadmap: promise ⇒ durable commitment or reword) ─────

/** Future-action promise shapes in the agent's own reply. */
const PROMISE_RE =
  /(kore (debo|dibo|dicchi)|করে (দেবো|দিচ্ছি|দেব)|banabo|বানাবো|pathabo|পাঠাবো|likhe (debo|dibo)|লিখে (দেবো|দেব)|dekhe (janabo|bolbo)|দেখে (জানাবো|বলবো)|janabo|জানাবো|kore rakhbo|করে রাখবো|করবো(?!\s*\?)|korbo(?!\s*\?)|আপডেট (দেবো|দিচ্ছি)|update (debo|dicchi)|পরে (করবো|দেবো))/i

/** "Doing it right now / already done" shapes are NOT open promises. */
const IMMEDIATE_RE = /(kore (dilam|diyechi|felechi)|করে (দিলাম|দিয়েছি|ফেলেছি)|hoye (geche|gelo)|হয়ে (গেছে|গেল)|এই যে|nicche|নিচ্ছি এখনই|করছি এখনই)/i

export interface CommitmentEvidence {
  /** A focus/open-task/card/reminder was durably created or updated this turn. */
  focusCreatedOrUpdated?: boolean
  openTaskTracked?: boolean
  cardStaged?: boolean
  reminderSet?: boolean
}

export interface CommitmentVerdict {
  promised: boolean
  durable: boolean
  ok: boolean
  /** The matched promise phrase (for the span/audit). */
  phrase: string | null
}

/**
 * The ledger check: an announced FUTURE action must be backed by durable
 * state (focus/open task/card/reminder) created this turn — otherwise the
 * wording must not promise. Pure; the turn records the verdict and (live
 * mode) creates the missing focus.
 */
export function checkCommitmentLedger(replyText: string, evidence: CommitmentEvidence): CommitmentVerdict {
  const t = (replyText ?? '').trim()
  const m = PROMISE_RE.exec(t)
  const promised = Boolean(m) && !IMMEDIATE_RE.test(t)
  const durable = Boolean(
    evidence.focusCreatedOrUpdated || evidence.openTaskTracked || evidence.cardStaged || evidence.reminderSet,
  )
  return { promised, durable, ok: !promised || durable, phrase: promised ? (m?.[0] ?? null) : null }
}

/** Reply contains a banned owner address (contract violation). */
export function violatesAddressContract(replyText: string): boolean {
  return OWNER_ADDRESS_BANNED.some((w) => new RegExp(`(^|[\\s,।"'])${w}([\\s,।.!?"']|$)`, 'i').test(replyText ?? ''))
}
