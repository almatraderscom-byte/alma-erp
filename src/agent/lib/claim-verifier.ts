/**
 * Tool-claim verifier — server-side enforcement of HONESTY rule.
 *
 * Two layers:
 *  1. Specific regex rules (original 6 categories) — high-recall for critical actions.
 *  2. General ledger-based check — catches completion claims for ANY tool category
 *     that wasn't backed by a successful call this turn.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ClaimViolationCategory =
  | 'salah_mark'
  | 'salah_delay'
  | 'memory_save'
  | 'reminder_set'
  | 'staff_dispatch'
  | 'fb_post'
  | 'general_write'

export interface ClaimViolation {
  category: ClaimViolationCategory
  ruleId: string
  matchedSnippet: string
  requiredTools: string[]
}

export interface ToolLedgerEntry {
  toolName: string
  success: boolean
  error?: string
}

interface ClaimRule {
  id: string
  category: ClaimViolationCategory
  pattern: RegExp
  negationPattern?: RegExp
  requiredTools: string[]
}

// ── Patterns ────────────────────────────────────────────────────────────────

const FUTURE_INTENT = /(?:^|[\s,।.!?])(?:করব|করবো|রাখব|রাখবো|দেব|দেবো|পাঠাব|পাঠাবো|will\s+|going\s*to\s+|করার\s*চেষ্টা)(?:[\s,।.!?]|$)/i
const QUESTION_FORM = /পড়েছেন\s*কি|পড়লেন\s*কি|করেছেন\s*কি|\?\s*$/

const SALAH_NAME = /(?:যোহর|জোহর|জুহর|আসর|ফজর|ফোজর|মাগরিব|ইশা|ইশার|fajr|fojr|dhuhr|zuhr|asr|maghrib|isha)/i

// ── Specific regex rules (Layer 1 — original 6 categories) ────────────────

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
    pattern: /(?:মনে\s*রাখলাম|মনে\s*রেখেছি|মনে\s*রাখা\s*হয়েছে|memory\s*[-_]?এ?\s*(?:সেভ|save|রাখ[লোছিা]+)|saved\s*(?:to\s*)?memory|মেমোরিতে\s*রাখলাম|মেমোরি\s*তে\s*সেভ)/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['save_memory'],
  },
  {
    id: 'reminder_set',
    category: 'reminder_set',
    pattern: /(?:reminder\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|রিমাইন্ডার\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|alarm\s*সেট\s*(?:কর[লোছিা]+|হয়েছে)|reminder\s*added|মনে\s*করিয়ে\s*দেব[ো]?\s*\d)/i,
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
    pattern: /(?:facebook\s*(?:এ\s*)?পোস্ট\s*(?:কর[লোছিা]+|হয়েছে|করে\s*দি[লেছিা]+)|FB\s*এ?\s*পোস্ট\s*(?:কর[লোছিা]+|হয়েছে)|পোস্ট\s*(?:করে\s*ফেলেছি|করে\s*দিয়েছি|করে\s*দিলাম|হয়ে\s*গেছে))/i,
    negationPattern: FUTURE_INTENT,
    requiredTools: ['post_to_facebook'],
  },
]

// ── Tool → Category mapping (Layer 2 — general ledger check) ──────────────

type ToolActionCategory =
  | 'write' | 'send' | 'mark' | 'post' | 'update'
  | 'save' | 'delete' | 'approve' | 'set' | 'log'
  | 'create' | 'dispatch' | 'generic'

export const TOOL_CATEGORY: Record<string, ToolActionCategory> = {}

// Auto-classify by prefix
const CATEGORY_PREFIXES: [string, ToolActionCategory][] = [
  ['mark_', 'mark'], ['save_', 'save'], ['send_', 'send'],
  ['post_', 'post'], ['update_', 'update'], ['set_', 'set'],
  ['log_', 'log'], ['add_', 'create'], ['create_', 'create'],
  ['delete_', 'delete'], ['edit_', 'update'], ['approve_', 'approve'],
  ['reject_', 'approve'], ['dispatch', 'dispatch'], ['publish', 'post'],
  ['unpublish', 'post'], ['run_', 'write'], ['make_', 'write'],
  ['generate_', 'write'], ['manage_', 'write'], ['pause_', 'update'],
  ['resume_', 'update'], ['snooze_', 'update'], ['cancel_', 'delete'],
  ['forget_', 'delete'], ['retire_', 'delete'], ['duplicate_', 'create'],
  ['merge_', 'write'], ['correct_', 'update'], ['confirm_', 'approve'],
  ['prepare_', 'write'], ['propose_', 'write'], ['call_', 'send'],
  ['outbound_', 'send'], ['delegate_', 'dispatch'], ['request_', 'write'],
  ['web_research', 'write'],
]

function classifyTool(name: string): ToolActionCategory {
  if (TOOL_CATEGORY[name]) return TOOL_CATEGORY[name]
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (name.startsWith(prefix)) {
      TOOL_CATEGORY[name] = cat
      return cat
    }
  }
  TOOL_CATEGORY[name] = 'generic'
  return 'generic'
}

// ── Completion lexicon (Banglish/Bangla past-tense done-words) ──────────────
//
// Deliberately does NOT include the bare generic "করেছি" or the passive
// "হয়ে গেছে": those match benign read/analysis replies ("চেক করেছি",
// "যাচাই করেছি", "৬ দিন পুরোনো হয়ে গেছে") that aren't agent-action claims at
// all, which forced needless verification rewrites (re-running the whole turn =
// wasted tokens). Real action claims use a specific verb ("save করেছি",
// "পাঠিয়ে দিয়েছি", "করে দিলাম") — those stay — and the critical actions
// (salah/memory/reminder/dispatch/fb) are also caught by the Layer 1 rules.
const COMPLETION_CLAIMS = /(?:করে\s*দিয়েছি|করে\s*দিলাম|করে\s*ফেলেছি|পাঠিয়েছি|পাঠিয়ে\s*দিয়েছি|সেভ\s*করেছি|save\s*করেছি|mark\s*করেছি|post\s*করেছি|update\s*করেছি|delete\s*করেছি|set\s*করেছি|send\s*করেছি|log\s*করেছি|create\s*করেছি|dispatch\s*করেছি|approve\s*করেছি|publish\s*করেছি|done\s*হয়েছে|সম্পন্ন\s*হয়েছে|completed|successfully|kore\s*diyechi|kore\s*felesi|pathiyechi|save\s*korechi|set\s*korechi)/i

const CATEGORY_CLAIM_KEYWORDS: Record<ToolActionCategory, RegExp | null> = {
  mark: /mark|মার্ক|রেকর্ড/i,
  save: /save|সেভ|মনে\s*রাখ|memory/i,
  send: /send|পাঠা|pathao|message/i,
  post: /post|পোস্ট|publish|আপলোড/i,
  update: /update|আপডেট|edit|পরিবর্তন|change/i,
  set: /set|সেট|configure/i,
  log: /log|লগ|entry|রেকর্ড/i,
  create: /create|তৈরি|banao|বানা|add|যুক্ত/i,
  delete: /delete|মুছে|remove|সরিয়ে|বাদ/i,
  approve: /approve|অনুমোদন|reject/i,
  dispatch: /dispatch|পাঠিয়ে|ডিসপ্যাচ/i,
  write: null,
  generic: null,
}

// ── Core detection functions ─────────────────────────────────────────────────

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Layer 1: Scan reply text for specific action claims unbacked by tool calls.
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

/**
 * Layer 2: Ledger-based general verification.
 * Detects completion claims in text that don't have a matching successful
 * write-category tool call in the ledger.
 */
export function detectLedgerViolations(
  replyText: string,
  ledger: ToolLedgerEntry[],
): ClaimViolation[] {
  const text = replyText.trim()
  if (!text || text.length < 20) return []

  if (FUTURE_INTENT.test(text)) return []

  const claimMatch = COMPLETION_CLAIMS.exec(text)
  if (!claimMatch) return []

  const successfulCategories = new Set<ToolActionCategory>()
  for (const entry of ledger) {
    if (entry.success) {
      successfulCategories.add(classifyTool(entry.toolName))
    }
  }

  // If any write-category tool succeeded, the general claim is likely honest
  const writeCategories: ToolActionCategory[] = [
    'write', 'send', 'mark', 'post', 'update', 'save',
    'delete', 'approve', 'set', 'log', 'create', 'dispatch',
  ]
  const anyWriteSucceeded = writeCategories.some(c => successfulCategories.has(c))
  if (anyWriteSucceeded) return []

  // No write tool succeeded but the reply claims completion
  // Check if the claim specifically references an action category
  for (const [cat, re] of Object.entries(CATEGORY_CLAIM_KEYWORDS) as [ToolActionCategory, RegExp | null][]) {
    if (!re) continue
    if (re.test(text)) {
      const failedInCategory = ledger.filter(
        e => !e.success && classifyTool(e.toolName) === cat,
      )
      if (failedInCategory.length > 0) {
        return [{
          category: 'general_write',
          ruleId: `ledger_failed_${cat}`,
          matchedSnippet: stripWhitespace(claimMatch[0]).slice(0, 120),
          requiredTools: failedInCategory.map(e => e.toolName),
        }]
      }
    }
  }

  // Generic: claimed completion but no write tool ran at all
  if (ledger.length === 0 || !anyWriteSucceeded) {
    return [{
      category: 'general_write',
      ruleId: 'ledger_no_write_tool',
      matchedSnippet: stripWhitespace(claimMatch[0]).slice(0, 120),
      requiredTools: [],
    }]
  }

  return []
}

/**
 * Combined verification: Layer 1 (regex) + Layer 2 (ledger).
 */
export function verifyClaimsAgainstLedger(
  replyText: string,
  ledger: ToolLedgerEntry[],
): ClaimViolation[] {
  const toolNames = ledger.map(e => e.toolName)
  const regexViolations = detectClaimViolations(replyText, toolNames)
  if (regexViolations.length > 0) return regexViolations

  return detectLedgerViolations(replyText, ledger)
}

// ── Guidance + reminder builder ──────────────────────────────────────────────

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
    'হয় এখনই appropriate approve/dispatch tool call করুন, নয়তো honest বলুন: "ড্রাফট তৈরি — Approve কার্ড থেকে অনুমোদন দিলে পাঠাব"।',
  fb_post:
    'Facebook পোস্ট করার দাবি দিয়েছেন কিন্তু এই turn-এ post_to_facebook tool call হয়নি। ' +
    'এখনই post_to_facebook call করুন বা confirm card-এর জন্য অপেক্ষা করতে বলুন — পাঠানোর আগে "পোস্ট হয়েছে" বলবেন না।',
  general_write:
    'আপনি কাজ সম্পন্ন হওয়ার দাবি করেছেন কিন্তু এই turn-এ কোনো সফল write/action tool call হয়নি। ' +
    'এখনই প্রয়োজনীয় tool call করুন এবং success result পেলে তবেই confirm দিন। ' +
    'যদি tool call ব্যর্থ হয়ে থাকে → সততা সঙ্গে ব্যর্থতা স্বীকার করুন।',
}

export function buildVerificationReminder(violations: ClaimViolation[]): string {
  const lines: string[] = ['[VERIFICATION FAILED — সিস্টেম চেক]', '']
  lines.push('আপনার শেষ উত্তরে নিম্নলিখিত দাবি ধরা পড়েছে যা corresponding tool ছাড়াই বলা হয়েছে:')
  for (const v of violations) {
    const toolHint = v.requiredTools.length > 0
      ? ` → প্রয়োজন: ${v.requiredTools.join(' বা ')}`
      : ''
    lines.push(`- "${v.matchedSnippet}"${toolHint}`)
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

export const MAX_VERIFY_RETRIES = 2
