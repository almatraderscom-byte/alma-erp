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

/** Leftovers when a stream is cut mid-call, plus the DeepSeek/Qwen sentinels. */
const STRAY_MARKERS =
  /<\/?tool_call>|<\/?arg_key>|<\/?arg_value>|<\/?function_(?:calls|results)>|<\/?invoke\b[^>]*>|<\/?parameter\b[^>]*>|<\|?tool[_▁]?calls?[_▁]?(?:begin|end|sep)\|?>|<｜tool▁calls?▁(?:begin|end|sep)｜>/gi

export function stripToolCallMarkup(text: string): string {
  if (!text) return text
  // Cheap guard: the overwhelming majority of rounds carry none of this.
  if (!/<tool_call|<arg_key|<function_(?:calls|results)|<invoke\b|tool▁call|<\|tool|"type"\s*:\s*"tool_(?:use|call)"/i.test(text)) return text
  const cleaned = text
    .replace(JSON_TOOL_USE, '')
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
