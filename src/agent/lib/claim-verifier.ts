/**
 * Tool-claim verifier — server-side enforcement of HONESTY rule.
 *
 * Two layers:
 *  1. Specific regex rules (original 6 categories) — high-recall for critical actions.
 *  2. General ledger-based check — catches completion claims for ANY tool category
 *     that wasn't backed by a successful call this turn.
 *  3. P1 factual-claim gate — catches a fabricated live-data number/status stated
 *     with no successful read this turn (flag-gated).
 */
import { AGENT_FACT_GATE, AGENT_STYLE_GATE } from '@/agent/config'
import { isCopyOnlyOwnerRequest } from '@/agent/lib/owner-intent-contract'

// ── Types ──────────────────────────────────────────────────────────────────

export type ClaimViolationCategory =
  | 'salah_mark'
  | 'salah_delay'
  | 'memory_save'
  | 'todo_write'
  | 'reminder_set'
  | 'staff_dispatch'
  | 'fb_post'
  | 'general_write'
  | 'source_attribution'
  | 'missing_card'
  | 'prose_choice'
  | 'missing_ask'
  | 'instruction_mismatch'
  | 'fabricated_stat'
  | 'robotic_style'

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

// Todo-noun + completed write-down verb pieces (rule `todo_written` below).
// Verb list is completed forms ONLY — "লিখে রাখব" (future) can't match, so the
// rule needs no FUTURE_INTENT negation (which would wrongly suppress an honest
// "লিখে রাখলাম, কাল মনে করিয়ে দেব" via the "দেব" in the promise tail).
const TODO_NOUN = /(?:to-?do|টুডু|টু-?ডু|করণীয়(?:\s*তালিকা)?|টাস্ক\s*লিস্ট)/i
const TODO_DONE_VERB = /(?:লিখে\s*(?:রাখা\s*হয়েছে|রেখেছি|রাখলাম|দিয়েছি|দিলাম)|টুকে\s*(?:রেখেছি|রাখলাম)|তুলে\s*(?:রেখেছি|রাখলাম)|নোট\s*(?:করা\s*হয়েছে|করে\s*(?:রেখেছি|রাখলাম)|করেছি)|যোগ\s*(?:করা\s*হয়েছে|করে\s*(?:দিয়েছি|দিলাম)|করেছি)|যুক্ত\s*(?:করা\s*)?হয়েছে|add\s*(?:করা\s*হয়েছে|করে\s*(?:দিয়েছি|দিলাম)|করেছি|হয়েছে)|entry\s*(?:হয়েছে|দিয়েছি)|রাখা\s*হয়েছে|added|saved|noted)/i

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
    // Todo written-down honesty (live-hit 2026-07-24): a Grok head replied
    // "✅ Todo-তে লিখে রাখা হয়েছে" to a voice-call instruction with ZERO tool
    // calls — nothing written to agent_owner_todos. No todo rule existed and the
    // Layer 2 lexicon lacked the passive "লিখে রাখা হয়েছে" form, so the verifier
    // stayed silent. A todo noun near a completed write-down verb (either order)
    // now requires a todo tool call this turn.
    id: 'todo_written',
    category: 'todo_write',
    pattern: new RegExp(
      `${TODO_NOUN.source}[^\\n.।!?]{0,40}?${TODO_DONE_VERB.source}|${TODO_DONE_VERB.source}[^\\n.।!?]{0,30}?${TODO_NOUN.source}`,
      'i',
    ),
    // No QUESTION_FORM negation: its trailing `\?\s*$` would let a false claim
    // escape via a courtesy closer ("…লিখে রেখেছি। আর কিছু লাগবে?"), and the
    // completed-only verb forms above can't appear in a genuine question anyway.
    requiredTools: ['add_owner_todo', 'update_owner_todo', 'manage_work_todos'],
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
    // Source-attribution honesty (live-hit 2026-07-17): the head answered ads
    // performance from growth_control_room but told the owner "Meta MCP থেকে
    // লাইভ চেক করে দেখলাম". Claiming DATA CAME FROM Meta MCP is only true when
    // a meta_ads_* bridged tool actually ran this turn. Talking ABOUT the MCP
    // ("Meta MCP এখনো খোলেনি / বন্ধ / connect করা নেই") is not a source claim
    // and must not trigger — hence the fetch-verb requirement + negation.
    id: 'meta_mcp_source_claim',
    category: 'source_attribution',
    // "MCP থেকে চেক করলাম" AND "MCP-এ কোনো data নেই" both assert knowledge the
    // head can only have from an actual meta_ads_* call — the second form slipped
    // through the থেকে-only pattern on 2026-07-17 (it had called NO MCP tool).
    // Honest connection-state talk ("MCP এখনো খোলেনি / connect করা নেই") is
    // negated below and stays allowed.
    pattern: /(?:meta\s*)?mcp\s*(?:থেকে|দিয়ে|theke|diye|-?এ|-?তে|-?te)\s*[^\n.।!?]{0,40}?(?:লাইভ|চেক|দেখ|আন|নিয়ে|নিলাম|পেলাম|টেনে|data|ডেটা|সংখ্যা|report|রিপোর্ট|insight)/i,
    negationPattern: /(?:খোলেনি|খুলেনি|বন্ধ|পারিনি|পারলাম\s*না|যায়নি|আসেনি|connect\s*(?:করা\s*)?নেই|disabled|not\s*enabled|rollout|এখনো\s*(?:খোলে|আসে)নি)/i,
    requiredTools: ['meta_ads_*'],
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
// Live-hit 2026-07-24 additions: first-person "wrote it down" forms
// (লিখে রেখেছি/রাখলাম, নোট/টুকে করে রেখেছি, যোগ করেছি) plus the write-down-specific
// passive "লিখে রাখা হয়েছে". Other passives ("আপডেট করা হয়েছে", "পাঠানো হয়েছে")
// stay OUT — they legitimately describe third-party/ERP state in read replies.
const COMPLETION_CLAIMS = /(?:করে\s*দিয়েছি|করে\s*দিলাম|করে\s*ফেলেছি|পাঠিয়েছি|পাঠিয়ে\s*দিয়েছি|সেভ\s*করেছি|save\s*করেছি|mark\s*করেছি|post\s*করেছি|update\s*করেছি|delete\s*করেছি|set\s*করেছি|send\s*করেছি|log\s*করেছি|create\s*করেছি|dispatch\s*করেছি|approve\s*করেছি|publish\s*করেছি|done\s*হয়েছে|সম্পন্ন\s*হয়েছে|completed|successfully|লিখে\s*রাখা\s*হয়েছে|লিখে\s*রেখেছি|লিখে\s*রাখলাম|নোট\s*করে\s*(?:রেখেছি|রাখলাম)|টুকে\s*(?:রেখেছি|রাখলাম)|যোগ\s*করেছি|যোগ\s*করে\s*(?:দিয়েছি|দিলাম)|kore\s*diyechi|kore\s*felesi|pathiyechi|save\s*korechi|set\s*korechi|likhe\s*rakh(?:lam|echi)|likhe\s*rakha\s*hoyeche)/i

// A ✅-style checkmark next to a done-verb is a completion claim even when no
// verb from the lexicon above appears ("✅ Todo-তে লিখে রাখা হয়েছে" was exactly
// this). Only consulted when the turn had ZERO successful tool calls of ANY
// kind — with nothing read and nothing written, a checkmarked "হয়েছে" cannot be
// an honest report, so false positives on data-state prose are impossible.
const CHECKMARK_DONE_CLAIM = /(?:✅|✔️|✔|☑️)[^\n]{0,60}?(?:হয়েছে|হয়ে\s*গেছে|দিয়েছি|দিলাম|রেখেছি|রাখলাম|ফেলেছি|done|complete|added|saved|sent|hoyeche|diyechi)|(?:হয়েছে|হয়ে\s*গেছে|দিয়েছি|দিলাম|রেখেছি|রাখলাম|done|completed?)\s*[^\n]{0,10}?(?:✅|✔️|✔|☑️)/i

const CATEGORY_CLAIM_KEYWORDS: Record<ToolActionCategory, RegExp | null> = {
  mark: /mark|মার্ক|রেকর্ড/i,
  save: /save|সেভ|মনে\s*রাখ|memory/i,
  send: /send|পাঠা|pathao|message/i,
  post: /post|পোস্ট|publish|আপলোড/i,
  update: /update|আপডেট|edit|পরিবর্তন|change/i,
  set: /set|সেট|configure/i,
  log: /log|লগ|entry|রেকর্ড/i,
  create: /create|তৈরি|banao|বানা|add|যুক্ত|to-?do|টুডু|করণীয়|লিখে\s*রাখ|লিখে\s*রেখ|নোট|যোগ/i,
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

    // A trailing '*' in a required tool name is a prefix match — e.g.
    // 'meta_ads_*' is satisfied by ANY bridged Meta MCP tool call.
    const satisfied = rule.requiredTools.some((t) =>
      t.endsWith('*')
        ? toolsCalledThisTurn.some((n) => n.startsWith(t.slice(0, -1)))
        : calledSet.has(t),
    )
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
  const anyToolSucceeded = ledger.some((e) => e.success)
  // Checkmark fallback: no lexicon verb matched, but the reply pairs ✅ with a
  // done-verb AND the turn ran zero successful tools — fabricated completion.
  if (!claimMatch) {
    if (anyToolSucceeded) return []
    const check = CHECKMARK_DONE_CLAIM.exec(text)
    if (!check) return []
    return [{
      category: 'general_write',
      ruleId: 'checkmark_claim_no_tools',
      matchedSnippet: stripWhitespace(check[0]).slice(0, 120),
      requiredTools: [],
    }]
  }

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

// ── Card-detection (owner-facing approval / question card) ────────────────────
//
// The head narrates that an approval/confirmation/question card is now in front
// of the owner ("অনুমোদন কার্ড পাঠাচ্ছি", "approval card নিচে দিলাম", "confirm
// card এসেছে") — but NO interactive card actually surfaced this turn. This is
// the exact failure the owner reported: he was told a card was coming, kept
// asking, and it never appeared (a sub-agent created a DB-only pending action, or
// the head simply forgot to call the pending-action tool). The head must catch
// this itself and either actually surface the card or admit it couldn't.

// A card noun, optionally qualified (approval/confirm/question/অনুমোদন/প্রশ্ন…).
const CARD_NOUN = '(?:approval|approve|confirm(?:ation)?|question|yes[\\s/-]*no|অনুমোদন(?:ের)?|নিশ্চিতকরণ|প্রশ্ন|হ্যাঁ[\\s/-]*না)?\\s*(?:card|কার্ড)'
// Present/near-future "it is in front of the owner now" delivery verbs.
const CARD_DELIVERY = '(?:পাঠা(?:চ্ছি|লাম|চ্ছে|নো\\s*হ[য়ছ][েি]|নো\\s*হচ্ছে)|পাঠিয়ে(?:ছি|\\s*দিয়েছি|\\s*দিলাম)?|দিচ্ছি|দিলাম|দিয়ে\\s*দিলাম|দিয়েছি|আসবে|আসছে|এসেছে|দেখতে\\s*পাবেন|পাবেন|নিচে\\s*(?:দেখুন|আছে|দিলাম|পাবেন)|তৈরি\\s*কর[ছিলােয]+|surfac|show|sent|sending|pathacchi|pathalam|pathiyechi|dilam|diyechi)'

const CARD_PROMISE = new RegExp(
  `${CARD_NOUN}[^।.!?\\n]{0,45}?${CARD_DELIVERY}`,
  'i',
)
const CARD_PROMISE_REV = new RegExp(
  `${CARD_DELIVERY}[^।.!?\\n]{0,25}?${CARD_NOUN}`,
  'i',
)
// Honest "I couldn't surface it / it isn't showing" — never a violation.
const CARD_INABILITY = /(?:card|কার্ড)[^।.!?\n]{0,30}?(?:আসেনি|আসছে\s*না|দেখা\s*যাচ্ছে\s*না|পারিনি|পারলাম\s*না|পারছি\s*না|failed|আসেনা)|(?:card|কার্ড)\s*(?:তৈরি|surface|show)[^।.!?\n]{0,20}?(?:পারিনি|পারলাম\s*না)/i

/**
 * Detects an unbacked owner-facing card promise: the reply says an approval/
 * question card is now shown, but no confirm_card or ask_card was emitted this
 * turn. Only call this when both counts are zero.
 */
export function detectMissingCardViolation(replyText: string): ClaimViolation[] {
  const text = replyText.trim()
  if (text.length < 6) return []
  if (CARD_INABILITY.test(text)) return []

  const m = CARD_PROMISE.exec(text) ?? CARD_PROMISE_REV.exec(text)
  if (!m) return []

  return [{
    category: 'missing_card',
    ruleId: 'card_promised_not_emitted',
    matchedSnippet: stripWhitespace(m[0]).slice(0, 120),
    requiredTools: [],
  }]
}

// ── Prose-choice detection (owner rule 2026-07-07, live-hit 2026-07-16) ─────
//
// HARD RULE: giving the Boss a choice means an ask_user card — no exceptions.
// The prompt says so, but cheap heads still write "Option A: … Option B: …
// আপনি কোন পথে যেতে চান?" as plain prose, which the owner cannot tap. The
// missing-card detector can't catch it (nothing PROMISED a card), so this one
// looks for the choice itself. Deliberately narrower than the prompt rule:
// only enumerated options or which-path decision asks — free-form clarifying
// questions stay allowed in prose, so a rhetorical "?" can't loop the verifier.

/// Enumerated options offered in prose: "Option A:", "অপশন ক", or (ক)/(খ)
/// style list markers at line starts.
const PROSE_OPTIONS = /(?:\boption\s*[a-c১২৩]\s*[:।).]|অপশন\s*[কখগ১২৩ab]|(?:^|\n)\s*[•·▪-]?\s*\(?[কখগ]\)?\s*[).:।])/im
/// A decision question aimed straight at the owner.
// Owner-hit round 2 (2026-07-16 late): "এটা পাঠাবো নাকি আরও ফার্ম/সফট/কোনো
// পরিবর্তন চান?" slipped through — the ‑ো verb spellings (পাঠাবো/করবো…) and
// the "X নাকি Y?" either-or shape weren't covered. Both are now first-class:
// any question containing নাকি IS a choice, and the verb group accepts the
// optional ‑ো. "পরিবর্তন চান" joins the direct decision-request phrases.
const DECISION_ASK = /(?:কোন\s*(?:টা|টি|পথে?|দিকে?|অপশন|প্ল্যান)[^\n?।]{0,50}\?|কোনটা\s*(?:করব|আগে|চান|ভালো|নেব)|(?:যেতে|করতে|এগোতে|আগাতে|নিতে|চালাতে)\s+চান|আপনার\s*সিদ্ধান্ত\s*(?:চাই|দরকার|লাগবে)|সিদ্ধান্ত\s*(?:দিন|জানান|দেবেন)|(?:করব|পাঠাব|আগাব|এগোব|চালাব|বাড়াব|দেব|রাখব)ো?\s*কি(?:\s*না)?[^\n?।]{0,12}\?|নাকি\s+[^\n?]{0,60}\?|(?:কোনো\s*)?পরিবর্তন\s*(?:চান|লাগবে)|which\s+(?:one|option|path|plan)\b[^\n?]{0,50}\?)/i

/**
 * Detects an owner-facing choice asked in prose while NO ask card was emitted
 * this turn. Only call when the turn produced zero ask cards.
 */
export function detectProseChoiceViolation(replyText: string): ClaimViolation[] {
  const text = replyText.trim()
  if (text.length < 12) return []

  const ask = DECISION_ASK.exec(text)
  const options = PROSE_OPTIONS.exec(text)
  // Options list alone is fine (a report may enumerate scenarios); it becomes a
  // choice-ask when the reply also questions the owner. A direct decision
  // question fires on its own.
  const hit = ask ?? (options && /\?/.test(text) ? options : null)
  if (!hit) return []

  return [{
    category: 'prose_choice',
    ruleId: 'choice_asked_without_ask_card',
    matchedSnippet: stripWhitespace(hit[0]).slice(0, 120),
    requiredTools: ['ask_user'],
  }]
}
// ── Ask-guard (owner escalation 2026-07-16: "agent card diye ask kore na") ──
// The HARD RULE (2026-07-07) says every owner-facing choice = ask_user card;
// this detector ENFORCES it: a prose choice-question without an ask_user call
// this turn triggers the same verification-retry loop as a false claim.

// Numbered/lettered option list (2+ items) — the exact anti-pattern the rule bans.
const PROSE_OPTION_LIST = /(?:^|\n)\s*(?:[১২৩৪1-4][.)]|[কখগঘ][.)])\s+\S[^\n]*(?:\n\s*(?:[১২৩৪1-4][.)]|[কখগঘ][.)])\s+\S[^\n]*)+/
// "কোনটা করব/চান/নেব…" and "…করব, নাকি …?" style A-or-B questions.
const PROSE_CHOICE_Q = /(?:কোনটা|কোনটি|কোন\s*টা)\s*(?:করব|চান|নেব|দেব|ভালো|আগে)|(?:করব|দেব|পাঠাব|চালাব|নেব|বানাব)[^।.!?\n]{0,25}?নাকি[^।.!?\n]{2,60}\?|which\s+(?:one|option)\b/i
// Courtesy closers that are NOT choices — never violations.
const COURTESY_Q = /(?:আর\s*কী|আর\s*কি|অন্য\s*কিছু|কিছু\s*লাগবে|আর\s*কিছু)[^।.!?\n]{0,25}\?/

/**
 * Detects an owner-facing CHOICE asked in prose while no ask_user card was
 * created this turn. Options in plain text have no tappable buttons — the
 * owner literally cannot answer them the way the app intends.
 */
export function detectMissingAskViolation(
  replyText: string,
  toolNames: string[],
): ClaimViolation[] {
  if (toolNames.includes('ask_user')) return []
  const text = replyText.trim()
  if (text.length < 12 || !text.includes('?')) return []
  if (COURTESY_Q.test(text) && !PROSE_OPTION_LIST.test(text)) return []
  const m = PROSE_OPTION_LIST.exec(text) ?? PROSE_CHOICE_Q.exec(text)
  if (!m) return []
  return [{
    category: 'missing_ask',
    ruleId: 'choice_in_prose_without_ask_card',
    matchedSnippet: stripWhitespace(m[0]).slice(0, 120),
    requiredTools: ['ask_user'],
  }]
}

/**
 * Combined verification: Layer 1 (regex) + Layer 2 (ledger) + ask-guard.
 */
// ── P1 factual-claim gate ─────────────────────────────────────────────────────

/** A live-data figure stated adjacent to a data noun, in either order. */
const STAT_NEAR_DATA_RE =
  /(?:(?:\d[\d,]*|[০-৯][০-৯,]*)\s*(?:টি|টা|জন|টাকা|৳)?\s*(?:order|অর্ডার|stock|স্টক|বিক্রি|sales?|revenue|আয়|due|বাকি|payment|পেমেন্ট|customer|কাস্টমার|হাজিরা))|(?:(?:order|অর্ডার|stock|স্টক|বিক্রি|sales?|revenue|আয়|due|বাকি|payment|পেমেন্ট|customer|কাস্টমার)\s*(?:হয়েছে|আছে|:|=)?\s*(?:\d[\d,]*|[০-৯][০-৯,]*))/i

/** Read-category tool prefixes — a successful one means the figure is grounded. */
const READ_TOOL_PREFIX_RE = /^(get_|list_|read_|fetch_|search_|check_|view_|find_|lookup_|query_|count_)/

/** Owner-visible hedge → the model already disclosed the number is unverified. */
const STAT_HEDGE_RE = /যাচাই\s*করে?\s*(?:দেখি|নি|নেব)|আনুমানিক|approx|estimate|মেমরি\s*থেকে|নিশ্চিত\s*নই|মোটামুটি/i

/**
 * P1 — a live-data figure stated with NO successful read this turn and no hedge.
 * The completion-claim ledger check keys on "done" verbs, so a volunteered stat
 * ("আজ ৫টা অর্ডার হয়েছে") slips through; this catches it. Flag-gated; conservative
 * (needs a number adjacent to a data noun) and fails open.
 */
export function detectFabricatedStatViolations(
  replyText: string,
  ledger: ToolLedgerEntry[],
): ClaimViolation[] {
  if (!AGENT_FACT_GATE) return []
  if (FUTURE_INTENT.test(replyText) || STAT_HEDGE_RE.test(replyText)) return []
  if (ledger.some((e) => e.success && READ_TOOL_PREFIX_RE.test(e.toolName))) return []
  const m = STAT_NEAR_DATA_RE.exec(replyText)
  if (!m) return []
  return [{
    category: 'fabricated_stat',
    ruleId: 'stat_without_read',
    matchedSnippet: m[0].trim().slice(0, 60),
    requiredTools: [],
  }]
}

// ── BP6 robotic-style gate ────────────────────────────────────────────────────

/**
 * Unambiguous robotic filler only — each pattern is something a sharp human
 * partner would never text. Conservative on purpose: style retries cost a model
 * round, so we catch the worst offenders and let the prompt handle nuance.
 */
const ROBOTIC_FILLER_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'canned_opener', re: /^(?:অবশ্যই|নিশ্চিতভাবে|নিশ্চয়ই|certainly|of course|sure)[!,\s]/i },
  { id: 'great_question', re: /চমৎকার\s*প্রশ্ন|খুব\s*ভালো\s*প্রশ্ন|দারুণ\s*প্রশ্ন|great\s+question|excellent\s+question/i },
  { id: 'answer_is', re: /আপনার\s*প্রশ্নের\s*উত্তর(?:\s*হলো|\s*হচ্ছে|ে\s*বলি)/i },
  { id: 'hope_helps', re: /আশা\s*করি\s*(?:এই\s*)?(?:তথ্য|উত্তর)(?:টি|টা)?\s*(?:সহায়ক|কাজে)|hope\s+this\s+helps/i },
  { id: 'as_an_ai', re: /একজন\s*AI\s*হিসেবে|as\s+an\s+AI\b/i },
]

/** Count emoji-ish codepoints; owner-chat replies should stay at 0-2. */
function countEmoji(text: string): number {
  const m = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)
  return m ? m.length : 0
}

/**
 * BP6 — deterministic detection of unambiguous robotic style. Flag-gated
 * (AGENT_STYLE_GATE); rides the existing verification retry so the reply is
 * rewritten like a human partner, on any head model.
 */
export function detectRoboticStyleViolations(replyText: string): ClaimViolation[] {
  if (!AGENT_STYLE_GATE) return []
  const text = replyText.trim()
  if (!text) return []
  const out: ClaimViolation[] = []
  for (const { id, re } of ROBOTIC_FILLER_PATTERNS) {
    const m = re.exec(text)
    if (m) {
      out.push({ category: 'robotic_style', ruleId: id, matchedSnippet: m[0].slice(0, 60), requiredTools: [] })
      break // one style violation is enough to trigger the rewrite
    }
  }
  if (out.length === 0 && countEmoji(text) > 4) {
    out.push({ category: 'robotic_style', ruleId: 'emoji_overload', matchedSnippet: '(অতিরিক্ত emoji)', requiredTools: [] })
  }
  return out
}

// Explicit owner formatting constraints are not preferences. Models commonly
// obey the semantic update (for example 8 → 3) but then re-apply their default
// warm style and add an emoji. Keep this deliberately narrow and deterministic;
// more constraints can be added only with equally unambiguous detectors.
const NO_EMOJI_REQUEST = /(?:\b(?:no|without)\s+emojis?\b|(?:emoji|ইমোজি)[^।.!?\n]{0,24}?(?:ব্যবহার|use|দিও|দেও|দেবে|করো|কোরো|করবেন)[^।.!?\n]{0,12}?না)/i
const EMOJI_IN_REPLY = /\p{Extended_Pictographic}/u
const READY_COPY_BLOCK = /```(?:copy|caption|post|text)\s*\n[\s\S]*?\S[\s\S]*?\n```/i
const FENCED_BLOCK = /```[^\n]*\n[\s\S]*?\n```/g
const COPY_POST_WORK_PROMPT = /(?:[?？]|(?:এখন\s+)?চাইলে|approve|approval|অনুমোদন|বললে|বলুন|বলবেন|জানান|লাগলে|edit|এডিট|tweak|টুইক|আপনার\s+নির্দেশ|paste|পেস্ট|post|পোস্ট|publish|ads?\s*manager|campaign)/i

export function detectExplicitInstructionViolations(
  replyText: string,
  ownerInstructions: string,
): ClaimViolation[] {
  const violations: ClaimViolation[] = []

  if (NO_EMOJI_REQUEST.test(ownerInstructions) && EMOJI_IN_REPLY.test(replyText)) {
    const match = replyText.match(EMOJI_IN_REPLY)
    violations.push({
      category: 'instruction_mismatch',
      ruleId: 'owner_requested_no_emoji',
      matchedSnippet: match?.[0] ?? 'emoji',
      requiredTools: [],
    })
  }

  if (isCopyOnlyOwnerRequest(ownerInstructions)) {
    if (!READY_COPY_BLOCK.test(replyText)) {
      violations.push({
        category: 'instruction_mismatch',
        ruleId: 'copy_only_missing_deliverable',
        matchedSnippet: '(ready-to-use copy block অনুপস্থিত)',
        requiredTools: [],
      })
    } else {
      const outsideCopy = replyText.replace(FENCED_BLOCK, ' ').trim()
      if (COPY_POST_WORK_PROMPT.test(outsideCopy)) {
        violations.push({
          category: 'instruction_mismatch',
          ruleId: 'copy_only_post_work_question',
          matchedSnippet: outsideCopy.slice(-100),
          requiredTools: [],
        })
      }
    }
  }

  return violations
}

export function verifyClaimsAgainstLedger(
  replyText: string,
  ledger: ToolLedgerEntry[],
): ClaimViolation[] {
  const toolNames = ledger.map(e => e.toolName)
  const regexViolations = detectClaimViolations(replyText, toolNames)
  if (regexViolations.length > 0) return regexViolations

  const ledgerViolations = detectLedgerViolations(replyText, ledger)
  if (ledgerViolations.length > 0) return ledgerViolations

  return detectMissingAskViolation(replyText, toolNames)
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
  source_attribution:
    '"Meta MCP থেকে" ডেটা এনেছেন বলে দাবি দিয়েছেন কিন্তু এই turn-এ কোনো meta_ads_* tool call হয়নি — ' +
    'ডেটা আসলে অন্য উৎস (যেমন growth_control_room / Graph API) থেকে এসেছে। ' +
    'হয় এখনই সঠিক meta_ads_* tool call করে আসল MCP ডেটা আনুন, নয়তো সৎভাবে বলুন ডেটাটা কোন উৎস থেকে এসেছে — উৎস নিয়ে কখনো ভুল দাবি নয়।',
  todo_write:
    'Todo-তে লিখে রাখার দাবি দিয়েছেন কিন্তু এই turn-এ add_owner_todo (বা update_owner_todo / manage_work_todos) tool call হয়নি — agent_owner_todos-এ কিছুই লেখা হয়নি। ' +
    'এখনই add_owner_todo call করুন (title + প্রয়োজনে dueDate), success result পড়ে তবেই "লিখে রেখেছি" বলুন। ' +
    'tool call সম্ভব না হলে সততা সঙ্গে বলুন লেখা হয়নি — চ্যাট টেক্সট কখনো todo সেভ করে না।',
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
  missing_ask:
    'আপনি Boss-কে prose-এ option/চয়েস-প্রশ্ন দিয়েছেন কিন্তু ask_user card তৈরি করেননি — HARD RULE ভঙ্গ (2026-07-07)। ' +
    'prose-এর নম্বরওয়ালা option-এ Boss ট্যাপ করতে পারেন না। এখনই ask_user call করুন: question + ২–৪টা ছোট tappable option। ' +
    'উত্তর লেখায় option-list রাখবেন না — শুধু প্রসঙ্গ + ask_user card।',
  missing_card:
    'আপনি বলেছেন অনুমোদন/প্রশ্ন কার্ড স্যারের সামনে পাঠিয়েছেন/দিচ্ছেন — কিন্তু এই turn-এ আসলে কোনো confirm_card বা ask_card তৈরি হয়নি, তাই স্যারের স্ক্রিনে কোনো কার্ড আসেনি। ' +
    'কার্ড শুধু তখনই আসে যখন আপনি নিজে (head) approval-দরকার এমন action tool টি সরাসরি call করেন এবং সেটি pendingActionId ফেরত দেয় — sub-agent-এর তৈরি pending action স্ক্রিনে কার্ড দেখায় না। ' +
    'এখনই দুটি option: (ক) নিজে সঠিক approval tool টি call করুন যাতে আসল কার্ড surface করে; (খ) যদি এই মুহূর্তে সম্ভব না → চুপচাপ "পাঠিয়েছি" বলবেন না, সততা সঙ্গে বলুন কার্ড আসেনি এবং স্যারকে কী করতে হবে বলুন। কখনো "কার্ড পাঠিয়েছি" বলবেন না যদি কার্ড আসলে না আসে।',
  prose_choice:
    'আপনি Boss-কে prose-এর ভিতরে option/সিদ্ধান্তের প্রশ্ন দিয়েছেন কিন্তু ask_user tool call করেননি — Boss টেক্সটের ভিতরের option-এ tap করতে পারেন না (HARD RULE 2026-07-07: choice মানেই ask_user, ব্যতিক্রম নেই)। ' +
    'আবার লিখুন: বিশ্লেষণ/প্রেক্ষাপট prose-এ রাখুন, কিন্তু option-এর তালিকা আর "কোনটা করবেন?" জাতীয় প্রশ্ন prose থেকে সম্পূর্ণ বাদ দিন — সেগুলো ask_user call-এ দিন (question + ২-৪টি ছোট tappable option, প্রতিটি option এক লাইনের)। ' +
    'reply-র শেষ কাজ = ask_user call।',
  instruction_mismatch:
    'Boss-এর এই turn-এর স্পষ্ট output contract ভাঙা হয়েছে। no-emoji বললে সব emoji বাদ দিন। ' +
    'copy-only বললে সম্পূর্ণ ready-to-use লেখা একটি fenced ```copy block-এ দিন; কাজ হয়ে গেলে আর প্রশ্ন/option/permission চাইবেন না। ' +
    'content/count/অন্য instruction বদলাবেন না।',
  fabricated_stat:
    'আপনি লাইভ ডেটা (সংখ্যা/অর্ডার/স্টক/বিক্রি/টাকা/হাজিরা) উল্লেখ করেছেন কিন্তু এই turn-এ কোনো read tool দিয়ে সেটা যাচাই করেননি। ' +
    'হয় এখনই relevant read tool (get_/list_/check_…) call করে আসল সংখ্যাটা আনুন, নয়তো সততা সঙ্গে বলুন সংখ্যাটা যাচাই করা হয়নি ("যাচাই করে দেখিনি — আনুমানিক")। মেমরি থেকে নিশ্চিত সংখ্যা দেবেন না।',
  robotic_style:
    'আপনার উত্তরে রোবটিক ফিলার ধরা পড়েছে (canned opener / "চমৎকার প্রশ্ন" / "আপনার প্রশ্নের উত্তর হলো" / কর্পোরেট ক্লোজিং / emoji-বৃষ্টি)। ' +
    'একই কথাগুলোই আবার লিখুন — এবার একজন ধারালো মানুষ পার্টনারের মতো: সরাসরি আসল উত্তর দিয়ে শুরু, প্লেইন ভাষা, উষ্ণ কিন্তু সংক্ষিপ্ত, ফিলার সম্পূর্ণ বাদ। তথ্য/সিদ্ধান্ত কিছু বদলাবেন না — শুধু ধরন।',
}

export function buildVerificationReminder(violations: ClaimViolation[]): string {
  const categories = new Set(violations.map((v) => v.category))

  // Formatting/output-contract rewrites are not failed business actions. The
  // generic reminder below tells the model to call a tool when an action is
  // missing; weak heads followed that sentence and repeatedly tried ask_user or
  // delegation for a copy-only request. Keep this correction path explicitly
  // text-only so the rejected draft is replaced by one clean final answer.
  if (categories.size === 1 && categories.has('instruction_mismatch')) {
    const lines: string[] = ['[OUTPUT CONTRACT FAILED — TEXT-ONLY REWRITE]', '']
    for (const v of violations) lines.push(`- ${v.matchedSnippet}`)
    lines.push('')
    lines.push(CATEGORY_GUIDANCE.instruction_mismatch)
    lines.push('')
    lines.push(
      'এটি action failure নয়। কোনো tool call, ask_user, delegation, approval, option বা next-step প্রশ্ন করবেন না। ' +
      'আগের draft সম্পূর্ণ replace করে এখন শুধু corrected final reply দিন।',
    )
    return lines.join('\n')
  }

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
  for (const cat of categories) {
    lines.push(`[${cat}] ${CATEGORY_GUIDANCE[cat]}`)
  }
  lines.push('')
  lines.push('আবার পুরো reply লিখুন — এবার tool result-এর সঙ্গে honest ভাবে।')
  return lines.join('\n')
}

export const MAX_VERIFY_RETRIES = 2
