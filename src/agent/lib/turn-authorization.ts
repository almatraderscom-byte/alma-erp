import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'
import { resolveClassification } from '@/agent/tools/tool-contract'

/** Trusted, server-derived authorization for one owner message. */
export interface OwnerTurnAuthorization {
  allowMutations: boolean
  reason:
    | 'explicit_no_action'
    | 'explicit_action'
    | 'recordable_fact'
    | 'information_only'
    /**
     * Owner-approved fix (2026-07-14): the message continues an IN-FLIGHT job
     * (an ask-card answer bound to a workflow run, or a continuation reply
     * while runs are active). The mutation was authorized when the job started;
     * text-intent guessing must not re-litigate it. Set by run-owner-turn.
     */
    | 'workflow_continuation'
}

const EXPLICIT_NO_ACTION_RE =
  /(শুধু\s*(?:বলো|বলুন|জানাও)|কিছু\s*(?:কোরো|করো)\s*না|কোনো\s*(?:কাজ|action)\s*(?:কোরো|করো)\s*না|kichu\s*(?:koro|korba|koris|korben)\s*na|(?:sudhu|shudhu|just)\s*bolo|read[ -]?only|only\s+(?:tell|answer|explain)|do\s*not\s+do\s+anything|don't\s+do\s+anything|no\s+action)/i

const BARE_CONTINUATION_RE =
  /^(continue|resume|retry|চালাও|চালিয়ে\s*যাও|চালিয়ে\s*যাও|এগাও|আগাও|করো|koro|execute|run|approve|পাঠাও)[\s!.?,।]*$/i

// Read verbs such as check/দেখো/বলো/list are deliberately absent.
// Banglish imperatives (dao/daw/koro/banao…) ARE present — the owner types
// romanized Bangla by default and "amk pair code daw" is as explicit an action
// request as "দাও" (2026-07-14 incident: the gate read it as information-only,
// stripped live_browser_pair, and the head invented a wrong pairing flow).
// Every -ao imperative also accepts the -aw spelling the owner actually types
// ("pathaw"/"dekhaw"/"janaw" — live miss 2026-07-22: `message pathaw` was read
// as information-only and send_whatsapp got stripped mid-instruction).
const BANGLISH_IMPERATIVE_RE =
  /\b(?:dao|daw|de|den|dibi|dibe|dis|koro|kor|korun|korbi|ban(?:ao|aw|au)|bana|chal(?:ao|aw)|cal(?:ao|aw)|chala|chol(?:ao|aw)|cholo|path(?:ao|aw)|pat(?:ao|aw)|kholo|khulo|khol|dekh(?:ao|aw|o)|lag(?:ao|aw)|tham(?:ao|aw)|bondho|chalu|generate)\b/i

// Naming the effect tool plus its browser action is an explicit instruction,
// even when the surrounding imperative is Bengali and outside the deliberately
// narrow generic Bangla grammar below.
const EXPLICIT_LIVE_BROWSER_ACT_RE =
  /\blive_browser_act\b[^\n]{0,120}(?:\b(?:navigate|click|type|press|select_option|scroll|action|execute|call|run)\b|চালাও|করো|করে\s*দাও)/i

// NOTE on Bangla imperatives: there is deliberately no Bangla counterpart to
// BANGLISH_IMPERATIVE_RE above. One was written (2026-08-16) and removed the same
// day: six review rounds found eleven P1s in it, because "order or question" in
// Bengali is a semantic call, not a lexical one — দিবে is also the future tense,
// নাও is also a boat, and the familiar 2nd-person present is spelled exactly like
// the imperative. The single tool it was needed for now sits in
// OWNER_SERVICE_TOOLS instead. If a future case needs this again, put the tool on
// that list rather than teaching this file grammar.

const EXPLICIT_ACTION_RE =
  /(\b(?:fix|create|make|add|update|change|edit|delete|remove|cancel|approve|reject|send|dispatch|assign|post|publish|upload|download|open|click|run|execute|start|continue|resume|retry|call|notify|schedule|set|save|remember|mark|log|generate|prepare|merge|apply|enable|disable)\b|(?:task|টাস্ক|কাজ)\s*(?:দাও|দেন|পাঠাও|assign|বানাও|তৈরি\s*করো)|(?:sms|message|মেসেজ|announcement|নোটিশ)\s*(?:দাও|পাঠাও|send)|(?:ছবি|image|photo|ভিডিও|video|reel|রিল|creative|ক্রিয়েটিভ)\s*(?:বানাও|তৈরি\s*করো|generate|make)|(?:audit|অডিট|research|রিসার্চ|বিশ্লেষণ|analysis|report|রিপোর্ট)\s*(?:করো|চালাও|run|বানাও|তৈরি\s*করো|prepare)|(?:website|ওয়েবসাইট|সাইট|browser|ব্রাউজার)\s*(?:খোলো|খুলে\s*দাও|open|fix|update|change|publish)|(?:যোগ|আপডেট|বদল|পরিবর্তন|ডিলিট|মুছ|বাতিল|ক্যানসেল|সেভ|পোস্ট|পাবলিশ|আপলোড|ডাউনলোড|শুরু|বন্ধ|চালু|লক|রিমাইন্ডার)\s*(?:করো|করুন|করে\s*দাও|দাও)?|মনে\s*(?:রাখো|রেখো|রাখবেন)|(?:kaj|task).*(?:koro|dao|daw|pathao|banao)|(?:kore|korey)\s*(?:dao|daw)|(?:কল|ফোন|call|fon|kol)\s*(?:করে|কোরে|kore|korey)[^\n।?]{0,24}?(?:জানা|জানি|jana|jani)|(?:কল|ফোন)\s*(?:দাও|দিও|দিবে|দিস|করো|কোরো|করবে))/i

// Some statements are themselves write instructions without an imperative.
// English imperative task orders. The owner writes plain English too, and the
// gate was Bangla/Banglish-only: "Do a Deep SEO Audit - almatraders.com"
// (live miss 2026-07-25) read as information_only, which silently disarmed the
// whole client_seo_batch delivery contract — the crawl still ran (stage tool)
// but nothing forced the finished report to ever be presented.
// Anchored to imperative POSITION (message start / after sentence punctuation)
// so mid-sentence question phrasing ("what do the numbers say", "SEO audit
// report-এ কী আছে?") stays information-only.
const ENGLISH_IMPERATIVE_RE =
  /(?:^|[.!?।\n]\s*)(?:please\s+|now\s+)?(?:do|perform|conduct|carry\s*out|complete|handle|build|rebuild|write|draft|compose|design|audit|analy[sz]e|research|crawl|scan|deploy|install|configure|refactor|migrate|translate|summari[sz]e)\b/i

/**
 * Scope words that turn a noun phrase into an order for END-TO-END work.
 * Owner's standing rule (2026-07-25): "deep/full" means the complete scope —
 * never a trimmed-down version — and such a request always ends in a
 * deliverable. Shared with owner-turn-requirements so one vocabulary drives
 * both the authorization gate and the requirement contract.
 */
// NOTE: `\b` is ASCII-only in JS, so Bangla alternatives must sit OUTSIDE the
// \b-fenced group or they can never match.
const DEEP_SCOPE_SRC =
  '(?:\\b(?:deep|full|complete|comprehensive|detailed|thorough|end[\\s-]*to[\\s-]*end|entire|whole)\\b|গভীর|পূর্ণ|সম্পূর্ণ|পুরো|বিস্তারিত)'
export const DEEP_SCOPE_RE = new RegExp(DEEP_SCOPE_SRC, 'i')

// A scope word + deliverable noun IS an order even without a verb:
// "Deep SEO Audit - almatraders.com", "full technical analysis of the site".
const DEEP_TASK_NOUN_RE = new RegExp(
  `${DEEP_SCOPE_SRC}[\\s-]+(?:[a-zঀ-৿]+[\\s-]+){0,3}`
    + '(?:\\b(?:audit|analysis|review|research|report|scan|crawl|breakdown|assessment|rebuild|revamp|overhaul)\\b'
    + '|অডিট|বিশ্লেষণ|রিসার্চ|রিপোর্ট|পর্যালোচনা)',
  'i',
)

const RECORDABLE_FACT_RE =
  /(poreci|porechi|porlam|পড়েছি|পড়েছি|পড়লাম|পড়লাম|qaza|কাযা|(?:namaz|নামাজ).*(?:missed|মিস)|(?:খরচ|expense|paid|payment|পেমেন্ট).*(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯|টাকা|taka|৳|bdt|aed|usd)|(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯).*(?:টাকা|taka|৳|bdt|aed|usd)?.*(?:খরচ|expense|paid|payment|পেমেন্ট)|(?:task|টাস্ক|কাজ).*(?:done|শেষ\s*করেছি|শেষ\s*করলাম|complete)|(?:ওষুধ|medicine|medication).*(?:খেয়েছি|খেয়েছি|took|নিয়েছি|নিয়েছি)|\+?\d{10,14}|\b(?:আমি|আমার|i)\b.*\b(?:prefer|পছন্দ|always|এখন\s*থেকে|from\s*now)\b)/i

// The Bengali interrogatives took a literal `\s`, so a SENTENCE-FINAL question
// word never matched: "তুমি করো কী" and "তুমি করো কী।" both read as statements
// (Codex P1). Bengali questions routinely end on the interrogative, and Boss
// often omits the question mark, so this was the common shape rather than an
// edge case. Punctuation and end-of-input are boundaries too. Widening this
// makes every branch that consults it STRICTER — more input is treated as a
// question, never less.
const QUESTION_RE = /[?？]|\b(?:what|why|how|when|where|who|which|status)\b|(?:কি|কী|কেন|কেমন|কত|কবে|কখন|কীভাবে|কিভাবে|কাকে|কোথায়|কারা|কোন)(?=[\s।.,!]|$)/i

export function deriveOwnerTurnAuthorization(text: string): OwnerTurnAuthorization {
  const t = text.trim()
  if (EXPLICIT_NO_ACTION_RE.test(t)) {
    return { allowMutations: false, reason: 'explicit_no_action' }
  }
  if (
    BARE_CONTINUATION_RE.test(t)
    || EXPLICIT_ACTION_RE.test(t)
    || BANGLISH_IMPERATIVE_RE.test(t)
    || EXPLICIT_LIVE_BROWSER_ACT_RE.test(t)
    || ENGLISH_IMPERATIVE_RE.test(t)
  ) {
    return { allowMutations: true, reason: 'explicit_action' }
  }
  // Verb-less deliverable order ("Deep SEO Audit - almatraders.com"). Guarded by
  // QUESTION_RE so "deep audit-এ কী পেলে?" stays a question.
  if (!QUESTION_RE.test(t) && DEEP_TASK_NOUN_RE.test(t)) {
    return { allowMutations: true, reason: 'explicit_action' }
  }
  if (!QUESTION_RE.test(t) && RECORDABLE_FACT_RE.test(t)) {
    return { allowMutations: true, reason: 'recordable_fact' }
  }
  return { allowMutations: false, reason: 'information_only' }
}

/**
 * Belt-and-suspenders (2026-07-25): a DELIVERABLE requirement derived from the
 * owner's own message is itself an action authorization. The two derivations
 * used to be able to contradict each other — the requirement contract told the
 * head "each target requires its own crawl, executed result, full report read
 * and download links", while the gate had marked the same message
 * information_only, so `ensureClientSeoBatchWorkflow` never ran and none of
 * that contract was enforceable. An explicit "কিছু কোরো না" still wins.
 */
export function upgradeAuthorizationForDeliverable(
  authorization: OwnerTurnAuthorization,
  hasDeliverableRequirement: boolean,
): OwnerTurnAuthorization {
  if (authorization.allowMutations || !hasDeliverableRequirement) return authorization
  if (authorization.reason === 'explicit_no_action') return authorization
  return { allowMutations: true, reason: 'explicit_action' }
}

function toolMode(name: string): 'read' | 'stage' | 'write' {
  return resolveClassification(
    TOOL_CLASSIFICATION[name] ?? { domain: 'unclassified', mode: 'write', risk: 'medium' },
  ).mode
}

/**
 * Owner-service tools the gate must NEVER strip (owner-approved fix
 * 2026-07-14). These are reversible bookkeeping/service capabilities whose
 * absence breaks standing owner law or strands the agent:
 *  - ask_user: the agent must always be able to ASK (it is classified 'write'
 *    because it creates a card row, but it mutates nothing of the business);
 *  - save/update_memory: the MEMORY-FIRST rule captures durable facts every
 *    turn, question or not;
 *  - checkpoints/open-task chips: progress bookkeeping, never a business write;
 *  - live-browser pairing/switch: pure owner-service plumbing ("pair code দাও"
 *    was read as information-only and the head lost the pair tool entirely).
 */
const OWNER_SERVICE_TOOLS = new Set([
  // Showing Boss his own screen. `mac_desk_control` is classified write because a
  // whole-desk capture is sensitive, and that classification is right — it is what
  // keeps autonomous and scheduled runs from photographing his desk unasked (the
  // permission-mode gate in registry.ts reads cap.mode, and is untouched by this
  // list). But on a turn HE typed, the sensitivity argument is answered by the
  // asking: it changes nothing, it only looks.
  //
  // This replaces a Bangla imperative classifier that tried to decide "order or
  // question" from grammar. Six review rounds found eleven P1s in it — দিবে is
  // also the future tense, নাও is also a boat — because the question is semantic,
  // not lexical. The tool was only ever unreachable on ONE gate, so the exemption
  // belongs on the gate, not in a language model made of regex.
  //
  // Scoped by name, so the tool's other actions (keep_awake / allow_sleep /
  // power_status) ride along. They control sleep on his own Mac and touch no
  // business state; the worst case is a battery left awake.
  'mac_desk_control',
  // A prospective plan is UI/control metadata, not a business mutation.  The
  // owner routinely asks for a read-only audit *and* an up-front Codex-style
  // checklist; classifying make_plan as a DB write is useful for the registry,
  // but stripping it here makes those two explicit instructions contradictory
  // and leaves the native tracker with no agent_plan snapshot to render.
  'make_plan',
  'ask_user',
  'save_memory',
  'update_memory',
  'save_task_checkpoint',
  'track_open_task',
  'resolve_open_task',
  'live_browser_pair',
  'set_live_browser',
  // Taking a permission AWAY is always safe, and the phrases Boss uses to do it
  // ("আর নিজে কোরো না", "আবার জিজ্ঞেস কোরো") read as information_only to the
  // gate — so without this the stop request was refused and the grant kept
  // running (review bot, #667).
  'revoke_standing_permission',
])

/**
 * Owner-approved policy (2026-07-14), replacing "strip everything but reads":
 *  - explicit_no_action ("কিছু কোরো না") → reads + service tools only. The
 *    owner said don't act; even a card is noise.
 *  - information_only (the gate merely GUESSED no intent) → reads + service +
 *    STAGE tools stay. A stage tool only creates an approval card — the owner's
 *    Approve is the real gate — while direct writes stay blocked. Guessing
 *    wrong then costs one dismissible card instead of a stranded, tool-less
 *    head that invents flows (the 2026-07-14 pair-code incident).
 */
export function isToolAllowedForOwnerTurn(
  name: string,
  authorization: OwnerTurnAuthorization | undefined,
): boolean {
  // Background jobs and non-owner surfaces do not carry an owner-turn policy.
  if (!authorization || authorization.allowMutations) return true
  if (OWNER_SERVICE_TOOLS.has(name)) return true
  const mode = toolMode(name)
  if (mode === 'read') return true
  return mode === 'stage' && authorization.reason !== 'explicit_no_action'
}

export function filterToolsForOwnerTurn<T extends { name: string }>(
  tools: readonly T[],
  authorization: OwnerTurnAuthorization,
): T[] {
  if (authorization.allowMutations) return [...tools]
  return tools.filter((tool) => isToolAllowedForOwnerTurn(tool.name, authorization))
}

export function ownerTurnAuthorizationNote(authorization: OwnerTurnAuthorization): string {
  if (authorization.allowMutations) return ''
  if (authorization.reason === 'explicit_no_action') {
    return (
      '[SERVER ACTION GATE — READ ONLY]\n' +
      'Boss স্পষ্ট বলেছেন এই টার্নে কোনো কাজ নয় — শুধু তথ্য/ব্যাখ্যা। শুধু read tool ব্যবহার করুন; ' +
      'কোনো card/proposal/task/dispatch stage করবেন না। Boss স্পষ্টভাবে বললে পরের turn-এ করা যাবে।'
    )
  }
  return (
    '[SERVER ACTION GATE — তথ্য-টার্ন]\n' +
    'Boss-এর এই কথাটি সম্ভবত তথ্য/স্ট্যাটাস চাওয়া — সরাসরি কোনো write/execute হবে না (সেসব টুল এই টার্নে বন্ধ)। ' +
    'দরকার হলে approval card stage করা যাবে (Boss Approve করলে তবেই কার্যকর হবে) — কিন্তু Boss না চাইলে অকারণ card বানাবেন না। ' +
    'প্রশ্নের উত্তরটাই আগে দিন।'
  )
}
