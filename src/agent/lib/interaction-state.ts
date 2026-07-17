/**
 * Roadmap 1 Phase 36 — conversation interaction state as CODE, not prompt
 * wishes. Pure derivations over the turn's text + already-resolved routing
 * signals (head tier, continuity decision) — deterministic, testable, and
 * identical after any restart.
 */

export type InteractionMode =
  | 'work'
  | 'personal_listen'
  | 'coaching'
  | 'decision_support'
  | 'crisis_safety'
  | 'concise_status'
  | 'teaching'

export type EmotionRead = 'low' | 'anxious' | 'angry' | 'positive' | 'neutral'

export interface InteractionState {
  mode: InteractionMode
  emotion: EmotionRead
  /** Owner is correcting the agent's previous output/behaviour. */
  correction: boolean
  /** The agent owes a repair: correction + prior turn asserted something. */
  repairNeeded: boolean
  /** Preferred verbosity for THIS turn. */
  detail: 'short' | 'normal' | 'detailed'
}

// ── Deterministic nets (Bangla + Banglish + English) ─────────────────────────

/** Crisis/safety: self-harm or acute despair — highest priority, never work. */
const CRISIS_RE =
  /(বাঁচতে ইচ্ছা|বাচতে ইচ্ছা|ba+n?chte\s*i(ch|chh|cc)ha(\s*korche)?\s*na|moro?te\s*iccha|morte\s*icche|শেষ করে দিতে|suicide|self.?harm|নিজেকে শেষ|আর পারছি না.*(বাঁচ|জীবন)|jibon\s*(rakhte|sesh)|beche\s*theke\s*ki\s*hobe|বেঁচে থেকে কী হবে)/i

const ANGRY_RE = /(রাগ|রেগে|regeg?e?chi|birokto|বিরক্ত|ধুর|faltu\s*kaj|এসব কী|etar mane ki|কাজই হয় না)/i
const ANXIOUS_RE = /(tension|টেনশন|chinta|চিন্তা|voy|ভয়|osthir|অস্থির|ghum hocche na|nervous)/i
const LOW_RE = /(mon (kharap|valo nei|bhalo nei)|মন খারাপ|hotash|হতাশ|eka lagche|একা|kanna|কান্না|klanto|ক্লান্ত|hopeless|osohay|অসহায়|kichu valo lagche na|ভালো লাগছে না)/i
const POSITIVE_RE = /(darun|দারুণ|khub valo|খুব ভালো|alhamdulillah|আলহামদুলিল্লাহ|joss|জোস|great|thanks|dhonnobad|ধন্যবাদ|khushi|খুশি)/i

/** Owner correcting the agent ("na eta na", "vul korecho", "আগেরটা ভুল"). */
const CORRECTION_RE =
  /(^|\s)(na na|না না|eta na|এটা না|vul|ভুল|thik hoy ?ni|ঠিক হয়নি|abar (vul|ভুল)|erokom na|এরকম না|ami eta chai ?ni|এটা চাইনি|order na|আগেরটা)(\s|$|,|।)/i

/** Coaching / decision support asks. */
const DECISION_RE = /(ki kora uchit|কী করা উচিত|করবো কিনা|korbo kina|decision|সিদ্ধান্ত|kon ?ta (nibo|valo)|কোনটা (নেবো|ভালো)|should i|advice|poramorsho|পরামর্শ)/i
const COACHING_RE = /(kivabe (shikhbo|korbo|improve)|কীভাবে (শিখবো|করবো)|shekhao|শেখাও|guide koro|আমাকে বুঝিয়ে)/i

/** Short-status ask ("এক লাইনে বলো", "short e bolo"). */
const SHORT_RE = /(ek lain|এক লাইনে|short e|shortcut e|সংক্ষেপে|quick bolo|জলদি বলো|tldr)/i
const DETAILED_RE = /(bistarito|বিস্তারিত|details?( e| দাও)|puro ta bolo|পুরোটা বলো|breakdown)/i

export function deriveEmotion(text: string): EmotionRead {
  const t = (text ?? '').trim()
  if (!t) return 'neutral'
  if (LOW_RE.test(t)) return 'low'
  if (ANXIOUS_RE.test(t)) return 'anxious'
  if (ANGRY_RE.test(t)) return 'angry'
  if (POSITIVE_RE.test(t)) return 'positive'
  return 'neutral'
}

export function detectCorrection(text: string): boolean {
  return CORRECTION_RE.test((text ?? '').trim())
}

export function detectCrisis(text: string): boolean {
  return CRISIS_RE.test((text ?? '').trim())
}

export interface DeriveModeInput {
  text: string
  /** Head tier already resolved by the router ('personal' = confirmed listen). */
  headTier?: string | null
  /** Teaching intent already detected by the learning layer. */
  teaching?: boolean
  /** The continuity resolver saw a status query about in-flight work. */
  statusQuery?: boolean
}

/**
 * Mode ladder (first hit wins): crisis > listen > teaching > decision/
 * coaching > concise status > work. Deterministic — same inputs, same mode.
 */
export function deriveInteractionMode(input: DeriveModeInput): InteractionMode {
  const t = (input.text ?? '').trim()
  if (detectCrisis(t)) return 'crisis_safety'
  if (input.headTier === 'personal') return 'personal_listen'
  if (input.teaching) return 'teaching'
  if (DECISION_RE.test(t)) return 'decision_support'
  if (COACHING_RE.test(t)) return 'coaching'
  if (input.statusQuery && t.length <= 64) return 'concise_status'
  return 'work'
}

export function deriveInteractionState(input: DeriveModeInput & { priorAssistantAsserted?: boolean }): InteractionState {
  const mode = deriveInteractionMode(input)
  const correction = detectCorrection(input.text)
  return {
    mode,
    emotion: deriveEmotion(input.text),
    correction,
    repairNeeded: correction && (input.priorAssistantAsserted ?? true),
    detail: SHORT_RE.test(input.text) ? 'short' : DETAILED_RE.test(input.text) ? 'detailed' : 'normal',
  }
}
