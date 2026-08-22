/** Strict direct-use classifier for the first witnessed browser vertical. */
const YOUTUBE_SURFACE = /(?:\byoutube\b|\byoutu\.be\b|ইউটিউব)/i
const YOUTUBE_INTERACTION =
  /(?:\b(?:open|search|find|play|playing|watch|watching|listen|listening|start|begin|get|put\s+on)\b|khul(?:o|e)?|khol(?:o|e)?|khuj(?:e|o)?|chalao|bajao|dekhao|shunao|খোল|খুল|সার্চ|খুঁজ|প্লে|চালাও|চালিয়ে|চালিয়ে|বাজাও|বাজিয়ে|বাজিয়ে|দেখাও|শোনাও|শুনাও)/i
const YOUTUBE_PLAYBACK =
  /(?:\b(?:play|playing|watch|watching|listen|listening|start|begin|get|put\s+on)\b|chalao|bajao|dekhao|shunao|প্লে|চালাও|চালিয়ে|চালিয়ে|বাজাও|বাজিয়ে|বাজিয়ে|দেখাও|শোনাও|শুনাও)/i
const POTENTIAL_YOUTUBE_PLAYBACK =
  /(?:\b(?:play\w*|replay\w*|repeat\w*|restart\w*|skip\w*|watch\w*|listen\w*|start\w*|begin\w*|began|begun|get\w*|got|have\b[^\n]{0,160}\bplaying\b|put\w*\s+on|resum\w*|unpaus\w*)\b|chalao|bajao|dekhao|shunao|প্লে|চালাও|চালিয়ে|চালিয়ে|বাজাও|বাজিয়ে|বাজিয়ে|দেখাও|শোনাও|শুনাও)/i

const ENGLISH_BROWSER_ACTION = '(?:open|search|find|play|watch|listen(?:\\s+to)?|put\\s+on|(?:start|begin)\\s+(?:playing|watching|listening(?:\\s+to)?))'
const ENGLISH_DIRECT_REQUEST = new RegExp(
  [
    // "Play X on YouTube", "Please open YouTube", "On YouTube, put on X".
    `^(?:(?:hey|boss|now|please|pls)\\b[\\s,:-]*)*(?:(?:on\\s+)?youtube(?:\\.com)?\\b[\\s,:-]*)?${ENGLISH_BROWSER_ACTION}\\b`,
    // A real polite request, unlike "Where can I find…?" or "Can YouTube play…?".
    `^(?:please\\s+)?(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${ENGLISH_BROWSER_ACTION}\\b`,
    `^(?:(?:hey|boss|now|please|pls)\\b[\\s,:-]*)*do\\s+${ENGLISH_BROWSER_ACTION}\\b`,
    `^(?:i\\s+(?:want|need)\\s+you\\s+to|i(?:'d|\\s+would)\\s+like\\s+you\\s+to)\\s+${ENGLISH_BROWSER_ACTION}\\b`,
    // "Get Fix You playing on YouTube" / polite equivalent.
    `^(?:(?:hey|boss|now|please|pls)\\b[\\s,:-]*)*(?:get|have)\\s+[^\\n]{1,160}?\\s+(?:playing|running)\\b`,
    `^(?:please\\s+)?(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:get|have)\\s+[^\\n]{1,160}?\\s+(?:playing|running)\\b`,
    // Explicit device-first ordering. This only classifies the witnessed lane;
    // the paired-device parser still decides exact/unique target authority.
    `^(?:(?:hey|boss|now|please|pls)\\b[\\s,:-]*)*use\\s+[^\\n]{1,80}?\\s+to\\s+${ENGLISH_BROWSER_ACTION}\\b`,
    `^(?:(?:hey|boss|now|please|pls)\\b[\\s,:-]*)*on\\s+[^\\n,:]{1,80}[,:]\\s*${ENGLISH_BROWSER_ACTION}\\b`,
  ].join('|'),
  'i',
)
const BANGLA_OR_BANGLISH_DIRECT_REQUEST =
  /(?:\b(?:open|search|find|play|watch|listen)\s+(?:koro|koren|korun)\b|\b(?:khul(?:o|e)?|khol(?:o|e)?|khuj(?:e|o)?|chalao|bajao|dekhao|shunao)\b|(?:ওপেন|সার্চ|প্লে)\s*(?:করো|কোরো|করুন|করেন|করে\s*(?:দাও|দিন))|(?:চালিয়ে|চালিয়ে|বাজিয়ে|বাজিয়ে)\s*(?:দাও|দিন|দেন)|(?:খোল|খোলো|খুলো|খুলে\s*(?:দাও|দিন)|খুঁজে\s*(?:দাও|দিন|বের\s*করো|বের\s*করুন)|চালাও|চালান|বাজাও|বাজান|দেখাও|দেখান|শোনাও|শোনান|শুনাও|শুনান))/i

// Questions can contain every action token while still asking for an explanation:
// "Why won't YouTube play?", "Where can I find X?", "কীভাবে চালাই?".
const DIAGNOSTIC_QUESTION =
  /^(?:(?:hey|boss|please)\b[\s,:-]*)*(?:why|how(?!\s+about\b)|where|what|when|which|who|(?:do(?:es)?|did|is|are|was|were|has|have)\s+(?:i|you|we|they|he|she|it|this|that|youtube)\b|can\s+youtube|could\s+youtube|will\s+youtube)\b|^(?:কেন|কীভাবে|কিভাবে|কোথায়|কোথায়|কী|কি|কখন|কোন)\b/i

// Exclude a second, explicit software/content-production instruction, not a bare
// title word. "Play Fix You" and "Play The Script" are media requests; "open
// YouTube API docs and fix the bug" is software work.
const SOFTWARE_OR_CONTENT_WORK =
  /(?:^|\b(?:and|then|also)\s+)(?:please\s+)?(?:fix|debug|implement|develop|deploy|build|edit|design|create|produce|research|audit|write|generate)\b|(?:\b(?:bug|code|api|integration|feature|ui|thumbnail|content|trends?|report)\b|বাগ|কোড|এপিআই|থাম্বনেইল|কনটেন্ট|ট্রেন্ড|রিপোর্ট)[^\n।]{0,40}(?:\b(?:fix|debug|edit|design|create|produce|research|audit|write|generate)\s*(?:করো|কোরো|করুন|করেন|করে\s*(?:দাও|দিন))\b|ফিক্স\s*করো|ঠিক\s*করো|ডিবাগ\s*করো|এডিট\s*করো|ডিজাইন\s*করো|বানাও|তৈরি\s*করো|রিসার্চ\s*করো|গবেষণা\s*করো)/i
const NEGATED_ACTION =
  /(?:\b(?:do\s+not|don'?t|dont|never)\b[^\n]{0,40}\b(?:open|search|find|play|watch|listen|put\s+on|navigate|go[-\s]+to|type|click|press|scroll|hover|switch|close|select|upload|pause|stop|resume|continue|mute|unmute|next|previous)\b|(?:খুল|খোল|সার্চ|খুঁজ|প্লে|চালা|বাজা)[^\n।]{0,20}(?:করো\s*না|কোরো\s*না|না)|(?:চালিও|বাজিও)\s*না)/i

const POTENTIAL_YOUTUBE_MUTATION =
  /(?:\b(?:open\w*|reopen\w*|refresh\w*|reload\w*|search\w*|find\w*|found|look\w*\s+up|launch\w*|visit\w*|play\w*|replay\w*|repeat\w*|restart\w*|skip\w*|watch\w*|listen\w*|start\w*|begin\w*|began|begun|get\w*|got|put\w*\s+on|paus\w*|unpaus\w*|stop\w*|resum\w*|continu\w*|unmut\w*|mut\w*|next|previous|fullscreen\w*|caption\w*|setting\w*|theatre|theater|volume\w*|navigat\w*|go(?:es|ing|ne)?[-\s]+(?:to|back)|typ\w*|click\w*|press\w*|scroll\w*|hover\w*|switch\w*|clos\w*|select\w*|upload\w*)\b|খোল|খুল|সার্চ|খুঁজ|প্লে|চালা|বাজা|দেখা|শোনা|শুনা|থামা|মিউট|আনমিউট|পরের|আগের|নেভিগেট|যাও|যান|টাইপ|ক্লিক|প্রেস|চাপ|স্ক্রল|হোভার|সুইচ|ক্লোজ|বন্ধ|সিলেক্ট|আপলোড)/i

/**
 * Defense-in-depth boundary for semantically browser-mutating YouTube text.
 * It is intentionally broader than routing: a classifier miss may lose UX, but
 * it must never regain shell/background/Mac executor authority.
 */
export function isPotentialYouTubeComputerUseMutation(text: string): boolean {
  const value = text.trim()
  // This is an execution authority boundary, not the UX/router classifier.
  // Keep it monotonic: a question, negation, mixed clause, or unfamiliar
  // grammar may still receive a prose answer, but it must never regain shell,
  // background-browser, delegation, or generic Mac executor authority merely
  // because we parsed its grammar incorrectly. The nuanced direct classifier
  // above remains responsible for deciding whether to start the witnessed lane.
  return Boolean(value && YOUTUBE_SURFACE.test(value) && POTENTIAL_YOUTUBE_MUTATION.test(value))
}

export function isDirectYouTubeBrowserTask(text: string): boolean {
  const value = text.trim()
  return Boolean(
    value
    && YOUTUBE_SURFACE.test(value)
    && YOUTUBE_INTERACTION.test(value)
    // First release slice has one verifiable terminal state: playback. Pure
    // search/open requests remain status-only until they have their own exact
    // query/results proof contract; they must not be able to finish on prose.
    && YOUTUBE_PLAYBACK.test(value)
    && !DIAGNOSTIC_QUESTION.test(value)
    && (ENGLISH_DIRECT_REQUEST.test(value) || BANGLA_OR_BANGLISH_DIRECT_REQUEST.test(value))
    && !SOFTWARE_OR_CONTENT_WORK.test(value)
    && !NEGATED_ACTION.test(value),
  )
}

export function isYouTubePlaybackRequest(text: string): boolean {
  return isDirectYouTubeBrowserTask(text) && YOUTUBE_PLAYBACK.test(text)
}

/** Monotonic honesty boundary for playback language that missed direct-route
 * grammar. False-positive claim restriction is safer than allowing an
 * unproved "playing" outcome merely because the UX classifier missed a form. */
export function isPotentialYouTubePlaybackMutation(text: string): boolean {
  const value = text.trim()
  return Boolean(value && YOUTUBE_SURFACE.test(value) && POTENTIAL_YOUTUBE_PLAYBACK.test(value))
}

/**
 * Execution fallback boundary for a witnessed paired-Chrome task. The exported
 * name is retained for compatibility, but the boundary also rejects background
 * browsers and delegation: only the live_browser_* path may operate this turn.
 */
export const DIRECT_BROWSER_SHELL_DENYLIST = new Set([
  'run_mac_command',
  'start_cli_session',
  'send_to_cli_session',
  'drive_mac_app',
  'run_browser_task',
  'open_live_browser',
  'run_browser_recipe',
  'delegate_to_specialist',
  'manage_browser_logins',
])

/**
 * Closed execution lane for a direct witnessed YouTube turn. This is an
 * allowlist—not merely today's fallback denylist—so a newly added Mac/browser
 * executor cannot silently become an unreviewed escape hatch later.
 */
export const DIRECT_BROWSER_ALLOWED_TOOL_NAMES = new Set<string>([
  'live_browser_pair',
  'live_browser_status',
  'live_browser_look',
  'live_browser_act',
  'ask_user',
])

export function directBrowserFallbackError(toolName: string): string {
  return (
    `DIRECT_BROWSER_FALLBACK_BLOCKED: ${toolName} এই witnessed YouTube turn-এ নিষিদ্ধ। ` +
    'শুধু live_browser_status/pair/look/act দিয়ে Boss-এর paired Chrome-এই কাজ করো; shell, background browser, trust-policy mutation বা delegation fallback নয়।'
  )
}

/** One shared execution-time decision used by both owner model heads. */
export function directBrowserFallbackViolation(
  directBrowserTask: boolean,
  toolName: string,
): string | null {
  return directBrowserTask && !DIRECT_BROWSER_ALLOWED_TOOL_NAMES.has(toolName)
    ? directBrowserFallbackError(toolName)
    : null
}

/** Re-apply a turn's closed lane after any generic controller later injects
 * requirement tools (make_plan/save_memory/etc.). New tools fail closed. */
export function filterDirectBrowserToolInventory<T extends { name: string }>(
  tools: readonly T[],
  directBrowserTask: boolean,
  allowed: ReadonlySet<string> = DIRECT_BROWSER_ALLOWED_TOOL_NAMES,
): T[] {
  return directBrowserTask ? tools.filter((tool) => allowed.has(tool.name)) : [...tools]
}

/** Remove execution-denied discoveries before the native head can read them. */
export function sanitizeDirectBrowserFallbackMatches(data: {
  matches?: Array<{ name?: unknown }>
  note?: unknown
} | undefined): string[] {
  if (!data || !Array.isArray(data.matches)) return []
  const denied = data.matches
    .map((match) => String(match?.name ?? ''))
    .filter((name) => !DIRECT_BROWSER_ALLOWED_TOOL_NAMES.has(name))
  if (denied.length === 0) return []
  const deniedSet = new Set(denied)
  data.matches = data.matches.filter((match) => !deniedSet.has(String(match?.name ?? '')))
  const existing = typeof data.note === 'string' && data.note.trim() ? `${data.note.trim()} ` : ''
  data.note = `${existing}[হারনেস] witnessed Chrome turn-এ fallback নিষিদ্ধ বলে বাদ: ${denied.join(', ')}।`
  return denied
}

/** Exact tools required by the direct paired-Chrome path on every head. */
export const DIRECT_BROWSER_TOOL_NAMES = [
  'live_browser_pair',
  'live_browser_status',
  'live_browser_look',
  'live_browser_act',
] as const

const DIRECT_BROWSER_EXECUTION_TOOL_NAMES = new Set<string>([
  ...DIRECT_BROWSER_TOOL_NAMES,
  // `ask_user` is owner-registry backed, not part of PERSONAL_SAFE_TOOLS. Keep
  // it on the same fenced dispatch path during a personal direct-browser turn
  // so pairing/login/device cards cannot silently become an unknown tool call.
  'ask_user',
])

/** These tools live in the owner registry even when the conversation is personal. */
export function isDirectBrowserExecutionTool(toolName: string): boolean {
  return DIRECT_BROWSER_EXECUTION_TOOL_NAMES.has(toolName)
}
