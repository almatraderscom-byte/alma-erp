/**
 * Tool-claim verifier — server-side enforcement of HONESTY rule.
 *
 * Scans the agent's final reply text for action-completion claims (Bangla/Banglish)
 * and verifies that the corresponding tool was actually called this turn.
 * If a claim is detected without the matching tool call, a synthetic reminder
 * is injected so the model either calls the tool or revises the reply.
 *
 * Conservative regexes — match only past-tense completion claims, not questions
 * or future intents. False positives just trigger one extra retry; false
 * negatives let lies through. Recall on damaging claims (mark/lock) >> precision.
 */

export type ClaimViolationCategory =
  | 'salah_mark'
  | 'salah_delay'
  | 'memory_save'
  | 'reminder_set'
  | 'staff_dispatch'
  | 'fb_post'

export interface ClaimViolation {
  category: ClaimViolationCategory
  ruleId: string
  matchedSnippet: string
  requiredTools: string[]
}

interface ClaimRule {
  id: string
  category: ClaimViolationCategory
  /** Pattern that matches a clear past-tense completion claim */
  pattern: RegExp
  /** Optional regex that, if matched, suppresses the claim (e.g. question form) */
  negationPattern?: RegExp
  requiredTools: string[]
}

// Bangla \b doesn't work (non-ASCII), so anchor with whitespace/punctuation/string boundaries.
const FUTURE_INTENT = /(?:^|[\s,।.!?])(?:করব|করবো|রাখব|রাখবো|দেব|দেবো|পাঠাব|পাঠাবো|will\s+|going\s*to\s+|করার\s*চেষ্টা)(?:[\s,।.!?]|$)/i
const QUESTION_FORM = /পড়েছেন\s*কি|পড়লেন\s*কি|করেছেন\s*কি|\?\s*$/

const SALAH_NAME = /(?:যোহর|জোহর|জুহর|আসর|ফজর|ফোজর|মাগরিব|ইশা|ইশার|fajr|fojr|dhuhr|zuhr|asr|maghrib|isha)/i

const RULES: ClaimRule[] = [
  {
    id: 'salah_mark_with_waqt',
    category: 'salah_mark',
    pattern: new RegExp(
      `${SALAH_NAME.source}[^.।!?\\n]{0,40}?\\b(?:mark\\s*(?:কর|হ)|মার্ক\\s*(?:কর|হ)|রেকর্ড\\s*(?:কর|আপডেট\\s*হ)|(?:হয়ে?\\s*গেছ|হয়েছে|আপডেট\\s*হয়েছে|করে\\s*ফেলেছি|করে\\s*দিলাম|করে\\s*দিয়েছি|done\\s*হয়েছে))`,
      'i',
    ),
    negationPattern: QUESTION_FORM,
    requiredTools: ['mark_salah'],
  },
  {
    id: 'salah_no_more_calls',
    category: 'salah_mark',
    pattern: /(?:আর|এখন|এখনি|এখন\s*থেকে)\s*(?:call|কল|ফোন|cal+)\s*(?:আসবে\s*না|আসবেনা|আসবে\s+না|আস\s*বে\s*না)/i,
    requiredTools: ['mark_salah', 'request_salah_delay'],
  },
  {
    id: 'salah_delay_lock',
    category: 'salah_delay',
    pattern: /(?:[\d০-৯]+\s*(?:মিনিট|min|minute)[^\n.।!?]{0,30}?(?:সময়\s*দিলাম|delay\s*দিলাম|পর\s*কল|wait|কল\s*বন্ধ|lock\s*কর))|(?:lock\s*কর[ছেলিা]+)|(?:কল\s*বন্ধ\s*রাখ[লেছিা]+)|(?:reminder\s*বন্ধ\s*রাখ[লেছিা]+)/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['request_salah_delay'],
  },
  {
    id: 'memory_saved',
    category: 'memory_save',
    pattern: /(?:মনে\s*রাখলাম|মনে\s*রেখেছি|মনে\s*রাখা\s*হয়েছে|memory\s*[-_]?এ?\s*(?:সেভ|save|রাখ[লোছিা]+)|saved\s*(?:to\s*)?memory|মেমোরিতে\s*রাখলাম|মেমোরি\s*তে\s*সেভ)/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['save_memory'],
  },
  {
    id: 'reminder_set',
    category: 'reminder_set',
    pattern: /(?:reminder\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|রিমাইন্ডার\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|alarm\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|reminder\s*added|মনে\s*করিয়ে\s*দেব[ো]?\s*\d)/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['set_reminder'],
  },
  {
    id: 'staff_dispatched',
    category: 'staff_dispatch',
    pattern: /(?:টাস্ক\s*(?:পাঠিয়ে?\s*দিয়েছি|পাঠিয়েছি|dispatch\s*হয়েছে|delivered)|মেসেজ\s*পাঠিয়েছি\s*স্টাফ\s*কে|staff[-_\s]*কে?\s*পাঠিয়ে?\s*দিয়েছি|dispatch\s*সম্পন্ন)/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: [
      'approve_pending_dispatch',
      'approve_pending_staff_message',
      'send_staff_announcement',
      'add_staff_task_now',
    ],
  },
  {
    id: 'fb_posted',
    category: 'fb_post',
    pattern: /(?:facebook\s*(?:এ\s*)?পোস্ট\s*(?:কর[লোছিা]+|হয়েছে|করে\s*দি[লেছিা]+)|FB\s*এ?\s*পোস্ট\s*(?:কর[লোছিা]+|হয়েছে)|পোস্ট\s*(?:করে\s*ফেলেছি|করে\s*দিয়েছি|করে\s*দিলাম|হয়ে\s*গেছে))/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['post_to_facebook'],
  },
]

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Scan reply text for action claims unbacked by tool calls in this turn.
 * Returns empty array when reply is honest.
 */
export function detectClaimViolations(
  replyText: string,
  toolsCalledThisTurn: string[],
): ClaimViolation[] {
  const text = replyText.trim()
  if (!text) return []

  const calledSet = new Set(toolsCalledThisTurn)
  const violations: ClaimViolation[] = []

  for (const rule of RULES) {
    const m = rule.pattern.exec(text)
    if (!m) continue

    if (rule.negationPattern && rule.negationPattern.test(text)) continue

    // If any required tool was called, the claim is satisfied.
    const satisfied = rule.requiredTools.some((t) => calledSet.has(t))
    if (satisfied) continue

    violations.push({
      category: rule.category,
      ruleId: rule.id,
      matchedSnippet: stripWhitespace(m[0]).slice(0, 120),
      requiredTools: rule.requiredTools,
    })
  }

  return violations
}

const CATEGORY_GUIDANCE: Record<ClaimViolationCategory, string> = {
  salah_mark:
    'নামাজ mark করার দাবি দিয়েছেন কিন্তু এই turn-এ mark_salah tool call হয়নি। ' +
    'যদি আসলেই দরকার → এখনই mark_salah call করুন (waqt + status), success পড়ে confirm দিন। ' +
    'যদি owner আগে button click করেছেন বা auto-mark হয়ে গেছে → get_salah_status দিয়ে verify করুন এবং সততা সঙ্গে বলুন "ইতিমধ্যে mark করা আছে স্যার"।',
  salah_delay:
    'নামাজ delay/lock-এর দাবি দিয়েছেন কিন্তু এই turn-এ request_salah_delay tool call হয়নি। ' +
    'এখনই request_salah_delay call করুন (waqt + minutes), success হলে tool-এর resumeAtLabel দিয়ে confirm দিন। ' +
    'duty-window-এর বাইরে হলে tool error দেবে — তখন delay না বলে নামাজের জন্য উৎসাহ দিন।',
  memory_save:
    'স্মৃতিতে রেখেছেন বলে দাবি দিয়েছেন কিন্তু এই turn-এ save_memory tool call হয়নি। ' +
    'এখনই save_memory call করুন (scope + content), success পেলে তবেই "মনে রেখেছি" বলুন।',
  reminder_set:
    'Reminder সেট করার দাবি দিয়েছেন কিন্তু এই turn-এ set_reminder tool call হয়নি। ' +
    'এখনই set_reminder call করুন (title + dueAt ISO), success পেলে confirm দিন।',
  staff_dispatch:
    'স্টাফকে পাঠানোর দাবি দিয়েছেন কিন্তু এই turn-এ approve_pending_dispatch / approve_pending_staff_message / add_staff_task_now কোনোটাই হয়নি। ' +
    'হয় এখনই uupropriate approve/dispatch tool call করুন, নয়তো honest বলুন: "ড্রাফট তৈরি — Approve কার্ড থেকে অনুমোদন দিলে পাঠাব"।',
  fb_post:
    'Facebook পোস্ট করার দাবি দিয়েছেন কিন্তু এই turn-এ post_to_facebook tool call হয়নি। ' +
    'এখনই post_to_facebook call করুন বা confirm card-এর জন্য অপেক্ষা করতে বলুন — পাঠানোর আগে "পোস্ট হয়েছে" বলবেন না।',
}

/**
 * Build the synthetic reminder message to push the model into corrective behavior.
 * Treated as a "user" turn but framed as system verification — Bangla wording so
 * the model stays in language and tone.
 */
export function buildVerificationReminder(violations: ClaimViolation[]): string {
  const lines: string[] = ['[VERIFICATION FAILED — সিস্টেম চেক]', '']
  lines.push('আপনার শেষ উত্তরে নিম্নলিখিত দাবি ধরা পড়েছে যা corresponding tool ছাড়াই বলা হয়েছে:')
  for (const v of violations) {
    lines.push(`- "${v.matchedSnippet}" → প্রয়োজন: ${v.requiredTools.join(' বা ')}`)
  }
  lines.push('')
  lines.push('নিয়ম (HARD):')
  lines.push('1. Chat text কোনো action execute করে না — শুধু tool call execute করে।')
  lines.push('2. Tool call ছাড়া success/done/হয়েছে দাবি **সম্পূর্ণ নিষিদ্ধ**।')
  lines.push('3. এই মুহূর্তে দুটি option:')
  lines.push('   (ক) যদি action আসলেই দরকার → এখনই tool call করুন → success result পড়ুন → তারপর সংক্ষেপে confirm দিন।')
  lines.push('   (খ) যদি action আগে থেকেই হয়ে আছে (button click/auto-mark) → relevant verify tool call করে confirm করুন এবং সততা সঙ্গে "ইতিমধ্যে হয়ে আছে" বলুন।')
  lines.push('   (গ) যদি action সম্ভব না বা ভুল ছিল → সততা সঙ্গে স্বীকার করুন: "করতে পারিনি/ভুল বলেছি"।')
  lines.push('')
  const categories = new Set(violations.map((v) => v.category))
  for (const cat of categories) {
    lines.push(`[${cat}] ${CATEGORY_GUIDANCE[cat]}`)
  }
  lines.push('')
  lines.push('আবার পুরো reply লিখুন — এবার tool result-এর সঙ্গে honest ভাবে।')
  return lines.join('\n')
}

/**
 * Hard cap on retries to avoid infinite loops if the model keeps lying.
 */
export const MAX_VERIFY_RETRIES = 2
