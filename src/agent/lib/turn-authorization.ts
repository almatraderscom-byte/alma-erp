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
  /\b(?:dao|daw|de|den|dibi|dibe|dis|koro|kor|korun|korbi|ban(?:ao|aw|au)|bana|chal(?:ao|aw)|cal(?:ao|aw)|chala|path(?:ao|aw)|pat(?:ao|aw)|kholo|khulo|khol|dekh(?:ao|aw)|lag(?:ao|aw)|tham(?:ao|aw)|bondho|chalu|generate)\b/i

const EXPLICIT_ACTION_RE =
  /(\b(?:fix|create|make|add|update|change|edit|delete|remove|cancel|approve|reject|send|dispatch|assign|post|publish|upload|download|open|click|run|execute|start|continue|resume|retry|call|notify|schedule|set|save|remember|mark|log|generate|prepare|merge|apply|enable|disable)\b|(?:task|টাস্ক|কাজ)\s*(?:দাও|দেন|পাঠাও|assign|বানাও|তৈরি\s*করো)|(?:sms|message|মেসেজ|announcement|নোটিশ)\s*(?:দাও|পাঠাও|send)|(?:ছবি|image|photo|ভিডিও|video|reel|রিল|creative|ক্রিয়েটিভ)\s*(?:বানাও|তৈরি\s*করো|generate|make)|(?:audit|অডিট|research|রিসার্চ|বিশ্লেষণ|analysis|report|রিপোর্ট)\s*(?:করো|চালাও|run|বানাও|তৈরি\s*করো|prepare)|(?:website|ওয়েবসাইট|সাইট|browser|ব্রাউজার)\s*(?:খোলো|খুলে\s*দাও|open|fix|update|change|publish)|(?:যোগ|আপডেট|বদল|পরিবর্তন|ডিলিট|মুছ|বাতিল|ক্যানসেল|সেভ|পোস্ট|পাবলিশ|আপলোড|ডাউনলোড|শুরু|বন্ধ|চালু|লক|রিমাইন্ডার)\s*(?:করো|করুন|করে\s*দাও|দাও)?|মনে\s*(?:রাখো|রেখো|রাখবেন)|(?:kaj|task).*(?:koro|dao|daw|pathao|banao)|(?:kore|korey)\s*(?:dao|daw)|(?:কল|ফোন|call|fon|kol)\s*(?:করে|কোরে|kore|korey)[^\n।?]{0,24}?(?:জানা|জানি|jana|jani)|(?:কল|ফোন)\s*(?:দাও|দিও|দিবে|দিস|করো|কোরো|করবে))/i

// Some statements are themselves write instructions without an imperative.
const RECORDABLE_FACT_RE =
  /(poreci|porechi|porlam|পড়েছি|পড়েছি|পড়লাম|পড়লাম|qaza|কাযা|(?:namaz|নামাজ).*(?:missed|মিস)|(?:খরচ|expense|paid|payment|পেমেন্ট).*(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯|টাকা|taka|৳|bdt|aed|usd)|(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯).*(?:টাকা|taka|৳|bdt|aed|usd)?.*(?:খরচ|expense|paid|payment|পেমেন্ট)|(?:task|টাস্ক|কাজ).*(?:done|শেষ\s*করেছি|শেষ\s*করলাম|complete)|(?:ওষুধ|medicine|medication).*(?:খেয়েছি|খেয়েছি|took|নিয়েছি|নিয়েছি)|\+?\d{10,14}|\b(?:আমি|আমার|i)\b.*\b(?:prefer|পছন্দ|always|এখন\s*থেকে|from\s*now)\b)/i

const QUESTION_RE = /[?？]|\b(?:what|why|how|when|where|who|which|status)\b|(?:কি|কী|কেন|কেমন|কত|কবে|কোথায়|কোথায়|কারা|কোন)\s/i

export function deriveOwnerTurnAuthorization(text: string): OwnerTurnAuthorization {
  const t = text.trim()
  if (EXPLICIT_NO_ACTION_RE.test(t)) {
    return { allowMutations: false, reason: 'explicit_no_action' }
  }
  if (BARE_CONTINUATION_RE.test(t) || EXPLICIT_ACTION_RE.test(t) || BANGLISH_IMPERATIVE_RE.test(t)) {
    return { allowMutations: true, reason: 'explicit_action' }
  }
  if (!QUESTION_RE.test(t) && RECORDABLE_FACT_RE.test(t)) {
    return { allowMutations: true, reason: 'recordable_fact' }
  }
  return { allowMutations: false, reason: 'information_only' }
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
  'ask_user',
  'save_memory',
  'update_memory',
  'save_task_checkpoint',
  'track_open_task',
  'resolve_open_task',
  'live_browser_pair',
  'set_live_browser',
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
