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
  /\{\s*"name"\s*:\s*"[a-z_][a-z0-9_]*"\s*,\s*"(?:arguments|parameters)"\s*:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*\}/gi
/** A fenced block the model labelled as a tool call — fence and contents both. */
const FENCED_TOOL_BLOCK =
  /```(?:tool|tool_call|tool_code|function_calls?)\b[\s\S]*?(?:```|$)/gi

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
  /<tool_call|<arg_key|<parameter\b|<function_(?:calls|results)|<invoke\b|tool▁call|<\|tool|```(?:tool|function_calls?)\b|"type"\s*:\s*"tool_(?:use|call)"|\{\s*"name"\s*:\s*"[a-z_][a-z0-9_]*"\s*,\s*"(?:arguments|parameters)"\s*:/i

export function stripToolCallMarkup(text: string): string {
  if (!text) return text
  if (!HAS_TOOL_MARKUP.test(text)) return text
  const cleaned = text
    // Fences first: the block is removed WITH its contents, so a stripped call
    // cannot leave an empty ``` card behind.
    .replace(FENCED_TOOL_BLOCK, '')
    .replace(JSON_TOOL_USE, '')
    .replace(JSON_NAME_ARGS, '')
    .replace(FUNCTION_CALLS_BLOCK, '')
    .replace(INVOKE_BLOCK, '')
    .replace(TOOL_CALL_BLOCK, '')
    .replace(NAMED_TOOL_ARGS, '')
    .replace(STRAY_MARKERS, '')
    // The removal usually leaves the blank line the markup sat on.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Never turn a reply into nothing: if the markup WAS the whole message, the
  // caller's own "this round said nothing" handling is the right outcome, and
  // that is what an empty string gives it.
  return cleaned
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
