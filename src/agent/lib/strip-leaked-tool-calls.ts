/**
 * A tool call is not a sentence.
 *
 * Owner saw this twice on 2026-07-27, on the Qwen head: the model wrote its tool
 * call as PROSE and it was rendered to him verbatim, in the middle of an
 * otherwise normal Bangla reply —
 *
 *   <get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>
 *
 * Some OpenRouter-hosted models fall back to this XML-ish dialect when they lose
 * the structured tool-call channel. The adapter does not recognise it, so the
 * text passes straight through to the chat.
 *
 * Two rules here, and the second matters as much as the first:
 *
 *  1. Strip it from anything Boss reads. It is machine syntax; showing it is a
 *     bug whatever caused it.
 *  2. NEVER strip silently in a way that leaves a claim standing. The caller
 *     gets the list of tool names it found, so the turn can tell the difference
 *     between "the model narrated a call it also really made" and "the model
 *     only pretended" — the second is exactly what the claim verifier exists to
 *     catch, and quietly deleting the evidence would blind it.
 */

/**
 * `<tool_name> … </tool_call>` and the plain `<tool_call> … </tool_call>` form.
 * Deliberately narrow: it must contain a tool-call closing tag or an arg_key, so
 * ordinary prose with angle brackets (a comparison, an HTML snippet Boss asked
 * about) is never touched.
 */
const LEAKED_TOOL_CALL_RE =
  /<\s*(?:tool_call|[a-z][a-z0-9_]{2,60})\s*>[\s\S]{0,4000}?<\s*\/\s*tool_call\s*>/gi

/** The tool name in an opening tag, when it is not the generic wrapper. */
const OPEN_TAG_RE = /^<\s*([a-z][a-z0-9_]{2,60})\s*>/i

export interface StrippedToolCalls {
  /** The text with every leaked call removed and whitespace tidied. */
  text: string
  /** Tool names the leaked calls named, in order, deduped. */
  toolNames: string[]
  /** How many leaked blocks were removed. */
  count: number
}

export function stripLeakedToolCalls(input: string): StrippedToolCalls {
  if (!input || !/<\s*\/\s*tool_call\s*>/i.test(input)) {
    return { text: input, toolNames: [], count: 0 }
  }
  const names: string[] = []
  let count = 0
  const text = input.replace(LEAKED_TOOL_CALL_RE, (block) => {
    count++
    const m = OPEN_TAG_RE.exec(block)
    const name = m?.[1]?.toLowerCase()
    if (name && name !== 'tool_call' && !names.includes(name)) names.push(name)
    return ''
  })
  return {
    // Collapse the blank lines the removal leaves behind, so the reply reads as
    // if the machine syntax had never been there.
    text: text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim(),
    toolNames: names,
    count,
  }
}
