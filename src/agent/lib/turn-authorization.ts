import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'
import { resolveClassification } from '@/agent/tools/tool-contract'

/** Trusted, server-derived authorization for one owner message. */
export interface OwnerTurnAuthorization {
  allowMutations: boolean
  reason: 'explicit_no_action' | 'explicit_action' | 'recordable_fact' | 'information_only'
}

const EXPLICIT_NO_ACTION_RE =
  /(শুধু\s*(?:বলো|বলুন|জানাও)|কিছু\s*(?:কোরো|করো)\s*না|কোনো\s*(?:কাজ|action)\s*(?:কোরো|করো)\s*না|read[ -]?only|only\s+(?:tell|answer|explain)|do\s*not\s+do\s+anything|don't\s+do\s+anything|no\s+action)/i

const BARE_CONTINUATION_RE =
  /^(continue|resume|retry|চালাও|চালিয়ে\s*যাও|চালিয়ে\s*যাও|এগাও|আগাও|করো|koro|execute|run|approve|পাঠাও)[\s!.?,।]*$/i

// Read verbs such as check/দেখো/বলো/list are deliberately absent.
const EXPLICIT_ACTION_RE =
  /(\b(?:fix|create|make|add|update|change|edit|delete|remove|cancel|approve|reject|send|dispatch|assign|post|publish|upload|download|open|click|run|execute|start|continue|resume|retry|call|notify|schedule|set|save|remember|mark|log|generate|prepare|merge|apply|enable|disable)\b|(?:task|টাস্ক|কাজ)\s*(?:দাও|দেন|পাঠাও|assign|বানাও|তৈরি\s*করো)|(?:sms|message|মেসেজ|announcement|নোটিশ)\s*(?:দাও|পাঠাও|send)|(?:ছবি|image|photo|ভিডিও|video|reel|রিল|creative|ক্রিয়েটিভ)\s*(?:বানাও|তৈরি\s*করো|generate|make)|(?:audit|অডিট|research|রিসার্চ|বিশ্লেষণ|analysis|report|রিপোর্ট)\s*(?:করো|চালাও|run|বানাও|তৈরি\s*করো|prepare)|(?:website|ওয়েবসাইট|সাইট|browser|ব্রাউজার)\s*(?:খোলো|খুলে\s*দাও|open|fix|update|change|publish)|(?:যোগ|আপডেট|বদল|পরিবর্তন|ডিলিট|মুছ|বাতিল|ক্যানসেল|সেভ|পোস্ট|পাবলিশ|আপলোড|ডাউনলোড|শুরু|বন্ধ|চালু|লক|রিমাইন্ডার)\s*(?:করো|করুন|করে\s*দাও|দাও)?|মনে\s*(?:রাখো|রেখো|রাখবেন)|(?:kaj|task).*(?:koro|dao|daw|pathao|banao)|(?:kore|korey)\s*(?:dao|daw))/i

// Some statements are themselves write instructions without an imperative.
const RECORDABLE_FACT_RE =
  /(poreci|porechi|porlam|পড়েছি|পড়েছি|পড়লাম|পড়লাম|qaza|কাযা|(?:namaz|নামাজ).*(?:missed|মিস)|(?:খরচ|expense|paid|payment|পেমেন্ট).*(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯|টাকা|taka|৳|bdt|aed|usd)|(?:\d|০|১|২|৩|৪|৫|৬|৭|৮|৯).*(?:টাকা|taka|৳|bdt|aed|usd)?.*(?:খরচ|expense|paid|payment|পেমেন্ট)|(?:task|টাস্ক|কাজ).*(?:done|শেষ\s*করেছি|শেষ\s*করলাম|complete)|(?:ওষুধ|medicine|medication).*(?:খেয়েছি|খেয়েছি|took|নিয়েছি|নিয়েছি)|\+?\d{10,14}|\b(?:আমি|আমার|i)\b.*\b(?:prefer|পছন্দ|always|এখন\s*থেকে|from\s*now)\b)/i

const QUESTION_RE = /[?？]|\b(?:what|why|how|when|where|who|which|status)\b|(?:কি|কী|কেন|কেমন|কত|কবে|কোথায়|কোথায়|কারা|কোন)\s/i

export function deriveOwnerTurnAuthorization(text: string): OwnerTurnAuthorization {
  const t = text.trim()
  if (EXPLICIT_NO_ACTION_RE.test(t)) {
    return { allowMutations: false, reason: 'explicit_no_action' }
  }
  if (BARE_CONTINUATION_RE.test(t) || EXPLICIT_ACTION_RE.test(t)) {
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

export function isToolAllowedForOwnerTurn(
  name: string,
  authorization: OwnerTurnAuthorization | undefined,
): boolean {
  // Background jobs and non-owner surfaces do not carry an owner-turn policy.
  if (!authorization || authorization.allowMutations) return true
  return toolMode(name) === 'read'
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
  return (
    '[SERVER ACTION GATE — READ ONLY]\n' +
    'Boss-এর বর্তমান কথাটি তথ্য/স্ট্যাটাস/ব্যাখ্যা চাওয়া; কোনো নতুন কাজ বা পরিবর্তনের অনুমতি নয়। ' +
    'শুধু read tool ব্যবহার করুন। proposal/card/task/todo/memory/browser action/dispatch বা অন্য কোনো stage/write করবেন না। ' +
    'আপনি নিজে কোনো পরের action প্রস্তাব করলেও সেটি অনুমতি হয়ে যাবে না; Boss স্পষ্টভাবে বললে পরের turn-এ করা যাবে।'
  )
}
