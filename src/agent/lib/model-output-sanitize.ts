/**
 * Raw tool-call markup must never reach Boss's screen.
 *
 * Seen live 2026-07-27 on the Qwen head. The reply read:
 *
 *   প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।
 *   <get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>
 *
 * The model wrote its tool call as TEXT instead of emitting a structured call.
 * The work itself survived — the next round called the tool properly — but he
 * was shown machine syntax in the middle of a Bangla sentence, which reads like
 * something is broken even when nothing is.
 *
 * This is a display repair, not a parser: the goal is that whatever the model
 * spills, the owner sees prose. It runs on the WHOLE round's prose, which both
 * emission paths in run-owner-turn produce as one block, so there is never a
 * half-streamed fragment to take back.
 *
 * Deliberately narrow. Only shapes that are unambiguously tool syntax are
 * removed; ordinary text that merely contains angle brackets (a size chart, a
 * code snippet Boss asked for) is left completely alone.
 */

/** `<tool_call> … </tool_call>`, including the unclosed tail a cut-off stream leaves. */
const TOOL_CALL_BLOCK = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi

/**
 * The shape Qwen produced: a tag named after the TOOL, argument pairs, then a
 * `</tool_call>` close that never matches it. Anchored on `<arg_key>` so a real
 * HTML-ish snippet cannot be caught by accident.
 */
const NAMED_TOOL_ARGS = /<[a-z_][a-z0-9_]*>\s*(?:<arg_key>[\s\S]*?<\/arg_value>\s*)+(?:<\/tool_call>)?/gi

/**
 * The JSON shape, seen live in the owner's own chat 2026-07-27 while he was
 * asking about ad spend:
 *
 *   {"type": "tool_use", "id": "tooluse_fPsTqJdFhXJz8Qm9Kw2LxN", "name": "recommend_ad_actions", "input": {}}
 *
 * Same failure as the XML one — the model wrote its call as text — but none of
 * the patterns above match it, so it went straight to his screen.
 *
 * Anchored on the literal `"type": "tool_use"` pair, and the match starts at the
 * opening brace, so ordinary JSON he asked for is untouched. `input` values are
 * shallow objects in practice; one level of nested braces is enough, and the
 * alternative — a brace counter — would be a parser, which this file is not.
 */
const JSON_TOOL_USE =
  /\{\s*"type"\s*:\s*"tool_(?:use|call)"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi

/**
 * The FOURTH shape, seen in his own chat 2026-07-27 — hours after the JSON one
 * shipped, in a reply about the whole business:
 *
 *   <function_calls> [get_sales_summary, get_orders, get_inventory_status,
 *   get_website_health, recommend_ad_actions] </function_calls>
 *
 * Not `<tool_call>`, not `<arg_key>`-anchored, not JSON — so all three existing
 * patterns missed it AND the cheap guard rejected the text before they ran.
 * `<function_results>` and `<invoke …>` are included with it: they are the rest
 * of the same family, and waiting to be shown each one on his screen first is a
 * bad way to find them.
 */
const FUNCTION_CALLS_BLOCK =
  /<function_(?:calls|results)>[\s\S]*?(?:<\/function_(?:calls|results)>|$)/gi
const INVOKE_BLOCK = /<invoke\b[\s\S]*?(?:<\/invoke>|$)/gi

/**
 * The FIFTH shape, seen live 2026-07-28 while testing the newly promoted skills.
 * Two different leaks in two consecutive turns, both from Qwen, both wrapped in
 * a markdown fence the UI then labelled "TOOL":
 *
 *   ```tool
 *   {"name": "marketing_report", "arguments": {"period": "last_7_days"}}
 *   ```
 *   ```tool
 *   <parameter name="limit">20</parameter>
 *   ```
 *
 * Two separate gaps, and the second one is the more embarrassing:
 *
 *  • `{"name": …, "arguments": …}` matched NO pattern here. `JSON_TOOL_USE` is
 *    anchored on `"type": "tool_use"`, which this shape does not carry.
 *  • `<parameter …>` was already in `STRAY_MARKERS` — but the cheap guard did
 *    not list it, so the function returned before any pattern ran. A pattern
 *    behind a guard that cannot reach it is not protection, it is decoration.
 *    That is why the guard below is now derived from the patterns rather than
 *    written out again by hand.
 *
 * The fence itself is removed with its contents, not just the call inside it:
 * an emptied ``` block renders as a bare card, which looks like a bug of its own.
 */
const JSON_NAME_ARGS =
  /\{\s*"name"\s*:\s*"[a-z_][a-z0-9_]*"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*\}/gi
/**
 * `<parameter name="x">value</parameter>` — removed as a PAIR, not as two tags.
 * `STRAY_MARKERS` deletes the tags only, which left the bare values behind:
 * stripping the live spill by tag alone produced `truetruetruetrue…`, which is
 * no better on his screen than the markup was.
 */
const PARAMETER_BLOCK = /<parameter\b[^>]*>[\s\S]*?(?:<\/parameter>|$)/gi
/** A fenced block the model labelled as a tool call — fence and contents both. */
const FENCED_TOOL_BLOCK =
  /```(?:tool|tool_call|tool_code|function_calls?)\b[\s\S]*?(?:```|$)/gi

/**
 * …and the GENERIC fence patterns, which arrived from the other session's fix
 * (#642) while this branch was in review. Both are kept: `FENCED_TOOL_BLOCK`
 * above is anchored on the fence LABEL, these two also catch a fence whose label
 * says nothing but whose body is plainly a typed call. Each catches what the
 * other misses, and a model inventing a new spelling is exactly the case where
 * two overlapping nets beat one clever one.
 */
const FENCED_TOOL_CALL =
  /```[ \t]*(?:[a-z0-9_-]*[ \t]*)?(?:tool|function)[ _-]?calls?[a-z0-9_ \t-]*\r?\n[\s\S]*?(?:```|$)/gi

const FENCED_TOOL_JSON =
  /```[a-z0-9_ \t-]*\r?\n\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input|parameters)"\s*:[\s\S]*?\}\s*\r?\n?(?:```|$)/gi

/** Leftovers when a stream is cut mid-call, plus the DeepSeek/Qwen sentinels. */
const STRAY_MARKERS =
  /<\/?tool_call>|<\/?arg_key>|<\/?arg_value>|<\/?function_(?:calls|results)>|<\/?invoke\b[^>]*>|<\/?parameter\b[^>]*>|<\|?tool[_▁]?calls?[_▁]?(?:begin|end|sep)\|?>|<｜tool▁calls?▁(?:begin|end|sep)｜>/gi

/**
 * Cheap guard: the overwhelming majority of rounds carry none of this, and
 * running six regexes over every reply for nothing is waste.
 *
 * It is written as one list next to the patterns it guards, because the 2026-07-28
 * leak was caused by exactly the drift a second hand-written copy invites: a
 * `<parameter …>` pattern existed, the guard did not mention it, and the guard
 * runs first. Any pattern added above must have its opening marker added here.
 */
const HAS_TOOL_MARKUP =
  /<tool_call|<arg_key|<parameter\b|<function_(?:calls|results)|<invoke\b|tool▁call|<\|tool|```[^\n]*(?:tool|function)[ _-]?calls?|```[^\n]*\r?\n\s*\{\s*"name"\s*:|"type"\s*:\s*"tool_(?:use|call)"|\{\s*"name"\s*:\s*"[a-z_][a-z0-9_]*"\s*,\s*"(?:arguments|input|parameters)"\s*:/i

/**
 * Complete-block variants of the `$`-tailed patterns above, for STREAMING use.
 *
 * Mid-stream, the "or end of string" alternative is a trap: it eats an
 * UNCLOSED `<tool_call>\nname` tail — opener and all — so when the rest of the
 * block arrives in the next delta there is no opener context left and the
 * remainder (`_ad_actions\n</tool_call>`) sails through as prose (live repro
 * 2026-08-15). The stream filter must strip only what has provably COMPLETED;
 * an unclosed opener stays in the held tail where `holdFrom` keeps it back.
 */
const TOOL_CALL_BLOCK_COMPLETE = /<tool_call>[\s\S]*?<\/tool_call>/gi
const FUNCTION_CALLS_BLOCK_COMPLETE =
  /<function_(?:calls|results)>[\s\S]*?<\/function_(?:calls|results)>/gi
const INVOKE_BLOCK_COMPLETE = /<invoke\b[\s\S]*?<\/invoke>/gi
const PARAMETER_BLOCK_COMPLETE = /<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi
const FENCED_TOOL_BLOCK_COMPLETE =
  /```(?:tool|tool_call|tool_code|function_calls?)\b[\s\S]*?```/gi
const FENCED_TOOL_CALL_COMPLETE =
  /```[ \t]*(?:[a-z0-9_-]*[ \t]*)?(?:tool|function)[ _-]?calls?[a-z0-9_ \t-]*\r?\n[\s\S]*?```/gi
const FENCED_TOOL_JSON_COMPLETE =
  /```[a-z0-9_ \t-]*\r?\n\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input|parameters)"\s*:[\s\S]*?\}\s*\r?\n?```/gi

export function stripToolCallMarkup(
  text: string,
  opts?: { streaming?: boolean },
): string {
  if (!text) return text
  if (!HAS_TOOL_MARKUP.test(text)) return text
  const streaming = opts?.streaming === true
  const cleaned = text
    // Fences first: the block is removed WITH its contents, so a stripped call
    // cannot leave an empty ``` card behind.
    .replace(streaming ? FENCED_TOOL_BLOCK_COMPLETE : FENCED_TOOL_BLOCK, '')
    .replace(streaming ? FENCED_TOOL_CALL_COMPLETE : FENCED_TOOL_CALL, '')
    .replace(streaming ? FENCED_TOOL_JSON_COMPLETE : FENCED_TOOL_JSON, '')
    .replace(JSON_TOOL_USE, '')
    .replace(JSON_NAME_ARGS, '')
    .replace(streaming ? FUNCTION_CALLS_BLOCK_COMPLETE : FUNCTION_CALLS_BLOCK, '')
    .replace(streaming ? INVOKE_BLOCK_COMPLETE : INVOKE_BLOCK, '')
    .replace(streaming ? PARAMETER_BLOCK_COMPLETE : PARAMETER_BLOCK, '')
    .replace(streaming ? TOOL_CALL_BLOCK_COMPLETE : TOOL_CALL_BLOCK, '')
    .replace(NAMED_TOOL_ARGS, '')
    // NEVER in streaming mode: `<\/?tool_call>` matches the OPENING tag too,
    // so this line was deleting a held opener out from under `holdFrom` and
    // the block's body then streamed through as prose (live repro 2026-08-15).
    // Stray single markers are a settled-text cleanup; the whole-round
    // sanitiser and flush() still run it.
    .replace(streaming ? /$^/ : STRAY_MARKERS, '')
    // The removal usually leaves the blank line the markup sat on.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  // Never turn a reply into nothing: if the markup WAS the whole message, the
  // caller's own "this round said nothing" handling is the right outcome, and
  // that is what an empty string gives it.
  // Streaming keeps boundary whitespace — a trim here would glue the next
  // delta's first word onto the previous one.
  return streaming ? cleaned : cleaned.trim()
}

/**
 * The same answer, twice, in one reply.
 *
 * Third sighting 2026-07-27/28 — the handoff already records "the same opening
 * line twice", and on the benchmark question the whole verdict block came out
 * twice: answer, evidence, ask for spec … answer, evidence, ask for spec. The
 * style rule "do not write the same thing twice" shipped and the very next run
 * did it again.
 *
 * So it is repaired rather than requested. Blocks are compared on their WORDS,
 * not their characters, because the second pass is usually a paraphrase — the
 * reason a plain equality check never caught it.
 *
 * Deliberately conservative:
 *  - only blocks of real length are considered (a repeated "ঠিক আছে" is fine);
 *  - the FIRST occurrence is always kept;
 *  - list items and short lines are never touched, because a list legitimately
 *    repeats its shape.
 */
const DUP_MIN_CHARS = 80
const DUP_SIMILARITY = 0.82

function wordSet(block: string): Set<string> {
  return new Set(
    (block.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2),
  )
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size)
}

/** Drop a later block that repeats an earlier one. Keeps the first. */
export function dropRepeatedBlocks(text: string): string {
  if (!text || text.length < DUP_MIN_CHARS * 2) return text
  const blocks = text.split(/\n\s*\n/)
  if (blocks.length < 2) return text

  const kept: string[] = []
  const keptWords: Array<Set<string>> = []
  for (const block of blocks) {
    const trimmed = block.trim()
    // Short blocks, headings and list items pass through untouched.
    if (trimmed.length < DUP_MIN_CHARS || /^\s*[-*•\d]/.test(trimmed)) {
      kept.push(block)
      continue
    }
    const words = wordSet(trimmed)
    if (keptWords.some((prev) => similarity(words, prev) >= DUP_SIMILARITY)) continue
    kept.push(block)
    keptWords.push(words)
  }
  return kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The STREAMING case, found the hard way 2026-07-28: the fixes above ran on the
 * finished round, and Boss's screen filled with `<parameter name="fullScanAll…">`
 * anyway — hundreds of lines of it, live, while the turn was still running.
 *
 * Reason: the round's PROSE is emitted as one block after cleaning, but the
 * model's THINKING is yielded token by token as it arrives. Nothing cleaned that
 * path, so a head that spills markup into its reasoning spills it onto his
 * screen, and the cleanup only ever fixed what got stored.
 *
 * Per-delta stripping cannot work on its own — `<param` and `eter name=…` arrive
 * as separate deltas. So this holds back the tail that could still turn into
 * markup, releases everything before it, and strips whatever completes.
 *
 * The hold-back is capped: ordinary reasoning that happens to contain a `<` (a
 * comparison, a size chart) must not stall the live thought forever, so once the
 * held tail passes MAX_HOLD without becoming markup it is released as prose.
 */
const MAX_HOLD = 300

/** Short, well-known HTML tags a business reply may legitimately contain. */
const HTML_TAGS = new Set([
  'b', 'i', 'u', 'p', 'em', 'br', 'hr', 'ul', 'ol', 'li', 'a', 'code', 'pre',
  'strong', 'small', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'table', 'tr', 'td', 'th',
])

/** A tag name that looks like TOOL markup, not prose formatting. */
function isToolishTag(name: string): boolean {
  const n = name.toLowerCase()
  if (HTML_TAGS.has(n)) return false
  return n.includes('_') || n.length >= 4
}

/** First bare (non-closing) tool-ish opener, or -1. */
function toolishOpenerAt(s: string): number {
  const re = /<([a-z_][a-z0-9_]*)>/gi
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (isToolishTag(m[1])) return m.index
  }
  return -1
}


/**
 * Where the still-unresolved tail begins, or -1.
 *
 * Not a regex over the tail: the live spill proved why. `<parameter name="fullScan"`
 * arrives as `<param` + `eter name="fullScan"` + `>true</parameter>`, and the
 * middle state contains spaces and quotes, so any "letters only after <" pattern
 * releases it one delta before it becomes markup. The honest question is simply
 * "is there an opener here that has not closed yet".
 */
function holdFrom(s: string): number {
  // The EARLIEST toolish opener wins over the latest bare '<': a held
  // `<tool_call>` whose body has begun must keep holding even when the body
  // itself contains a new partial tag (`…xyz</tool_c`) — returning the later
  // '<' released the opener and body as prose (live repro 2026-08-15).
  const earlyOpener = toolishOpenerAt(s)
  if (earlyOpener !== -1 && s.length - earlyOpener <= MAX_HOLD) return earlyOpener
  const lt = s.lastIndexOf('<')
  if (lt !== -1 && !s.includes('>', lt) && s.length - lt <= MAX_HOLD) return lt
  // A CLOSED tag can still be the opener of named-tool markup — the pattern is
  // only recognisable once <arg_key>/<parameter …> follows in a later delta
  // (Codex P1 #765). Hold a lone `<identifier>` (never a real prose token, and
  // never a closing `</…>`) until the next chunk proves it is not tool syntax.
  // A bare `<identifier>` opener anywhere in the tail: named-tool markup is a
  // CHAIN (<tool><arg_key>k</arg_key>…), and stripToolCallMarkup erases the
  // half-arrived links, so by the time the tail looks clean the opener has
  // already been released (Codex P1 #765 rounds 2-3). Hold from the opener
  // until the chain resolves or MAX_HOLD passes — ordinary prose with an
  // HTML-ish token is released a few hundred characters later, never lost.
  const openerAt = toolishOpenerAt(s)
  if (openerAt !== -1 && s.length - openerAt <= MAX_HOLD) return openerAt
  const fence = s.lastIndexOf('```')
  if (fence !== -1 && s.indexOf('```', fence + 3) === -1 && s.length - fence <= MAX_HOLD) return fence
  const brace = s.lastIndexOf('{')
  if (
    brace !== -1
    && !s.includes('}', brace)
    && s.length - brace <= MAX_HOLD
    && /^\{\s*"?(?:t(?:ype)?|n(?:ame)?)?/i.test(s.slice(brace))
  ) return brace
  return -1
}

export interface MarkupStreamFilter {
  /** Feed one delta; returns the text that is safe to show now (may be ''). */
  push(delta: string): string
  /** End of stream: returns whatever was held back, cleaned. */
  flush(): string
}

/**
 * Widen a hold point backwards over a run of complete simple tags and spaces.
 *
 * `<get_website_catalog>` + `<arg` (partial) would otherwise release the named
 * opener the moment the argument tag STARTS, because the unclosed `<arg` is a
 * later hold point (Codex P1 #765 round 2). Tool markup is a chain of such
 * tags, so once any part of the tail is suspicious the whole chain is.
 */
function extendHoldBackwards(s: string, cut: number): number {
  let at = cut
  for (;;) {
    const before = s.slice(0, at)
    const chain = /(?:<\/?[a-z_][a-z0-9_]*>\s*)$/i.exec(before)
    if (!chain) return at
    const next = at - chain[0].length
    if (next < 0 || s.length - next > MAX_HOLD) return at
    at = next
  }
}

export function createMarkupStreamFilter(): MarkupStreamFilter {
  let held = ''
  return {
    push(delta: string): string {
      held = stripToolCallMarkup(held + delta, { streaming: true })
      const rawCut = holdFrom(held)
      const cut = rawCut === -1 ? -1 : extendHoldBackwards(held, rawCut)
      // An opener that has not closed yet: keep it back until it resolves, or
      // until it grows past MAX_HOLD without becoming markup — ordinary prose
      // with a "<" in it must never stall the live thought.
      if (cut !== -1) {
        const out = held.slice(0, cut)
        held = held.slice(cut)
        return out
      }
      const out = held
      held = ''
      return out
    },
    flush(): string {
      // A chain that never resolved is markup the stream simply ended inside:
      // the whole-round sanitiser cannot recognise a half-arrived chain either,
      // so drop it here rather than spill it at the end (Codex P1 #765).
      let out = stripToolCallMarkup(held)
      const dangling = toolishOpenerAt(out)
      if (dangling !== -1) out = out.slice(0, dangling)
      held = ''
      return out
    },
  }
}

/**
 * Did the model TYPE its tool calls instead of making them?
 *
 * Stripping the markup fixes what Boss sees, and hides what actually went wrong:
 * a round that narrates three calls and makes none did no work, so the
 * think → tool → update → tool rhythm he watches for collapses into a wall of
 * text. He noticed the missing rhythm before anyone noticed the cause; this is
 * the detector that lets the turn notice it too.
 *
 * True only when the text carries tool syntax AND the round made no real call —
 * a model that narrates while also calling properly is merely chatty.
 */
export function typedToolCallsInsteadOfCalling(input: {
  rawText: string
  realToolCallCount: number
}): boolean {
  if (input.realToolCallCount > 0) return false
  if (!input.rawText?.trim()) return false
  return stripToolCallMarkup(input.rawText) !== input.rawText
}


/**
 * How many tool calls did the model TYPE?
 *
 * The round-level detector answers "did it type instead of calling", which is
 * false the moment the model does both — and doing both is exactly what Qwen did
 * live on 2026-07-28: one real call, three typed. So the turn needs the COUNT,
 * not the boolean, to see that most of the work was narrated.
 */
export function countTypedToolCalls(text: string): number {
  if (!text) return 0
  const patterns = [
    FENCED_TOOL_BLOCK,
    FENCED_TOOL_CALL,
    FENCED_TOOL_JSON,
    JSON_NAME_ARGS,
    PARAMETER_BLOCK,
    JSON_TOOL_USE,
    FUNCTION_CALLS_BLOCK,
    INVOKE_BLOCK,
    TOOL_CALL_BLOCK,
    NAMED_TOOL_ARGS,
  ]
  let n = 0
  for (const re of patterns) {
    re.lastIndex = 0
    n += (text.match(re) ?? []).length
  }
  return n
}
