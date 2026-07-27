/**
 * The owner watches the thinking. Plumbing does not belong in it.
 *
 * He compared his agent's process pane to mine on the same question. Mine held
 * reasoning about HIS problem. His held this:
 *
 *   > "The internal control is reminding me that in the previous turn I
 *   >  announced a step but didn't a…"
 *   > "The mandatory first line rule still applies from the previous context…"
 *   > "The verification failed because I asked a question in prose without
 *   >  using the ask_user tool."
 *   > "The new human message is actually internal control notes…"
 *
 * All four are the model reasoning about OUR HARNESS — control banners, the
 * first-line rule, the claim verifier — not about his business. A prompt rule
 * telling it not to narrate system instructions shipped, and the leak continued
 * on the very next turn. A prompt rule is a request; this is the guarantee.
 *
 * ── Deliberately narrow ─────────────────────────────────────────────────────
 *
 * He ASKED to see the thinking, so this is not a filter on English, or on
 * length, or on anything that would gut it. It drops a line only when the line
 * is about the machinery: our control notes, our injected rules, our verifier,
 * our tool plumbing. Reasoning about ads, stock, customers or a page stays
 * exactly as written, English or not.
 *
 * If every line is plumbing, the result is empty — and an empty thought block is
 * the honest outcome, because that round contained no thinking he wanted.
 */

import { createMarkupStreamFilter } from '@/agent/lib/model-output-sanitize'

/**
 * Line shapes that are unmistakably about the harness rather than the work.
 * Every entry here comes from a line he actually saw on screen.
 */
const PLUMBING_LINE: RegExp[] = [
  // control-note banners and the model's musings about them
  /internal control/i,
  /\bnot a (?:new )?boss message\b/i,
  /\bthe (?:new )?human message\b/i,
  // injected style/first-line rules
  /mandatory first line/i,
  /first line rule/i,
  // …and the model REPORTING that it obeyed the rule, which is the same leak
  // wearing a different sentence. Seen live 2026-07-28 as the entire visible
  // thought of a customer-support turn: "The first line has been outputted as
  // required." Matching the rule's name was not enough — it also has to match
  // the model ticking the rule off.
  /\bfirst line\b[^.]{0,40}\b(?:output|outputted|emitted|already|done|complete)/i,
  /\b(?:as|per) (?:required|instructed|the instruction)\b/i,
  /\bthe (?:system|instruction) (?:note|says|is)\b/i,
  // the server-side claim verifier
  /verification failed/i,
  /\bask_user tool\b/i,
  // narrating the tool plumbing rather than the finding
  /\bfind_tool returned\b/i,
  /\btool (?:budget|list) (?:is )?(?:exhausted|limited)\b/i,
  // owner-correction / skill nudges being read aloud
  /owner-correction/i,
  /\bskill (?:pinned|allowlist)\b/i,
]

/** Does this single line talk about our machinery instead of his business? */
export function isPlumbingThought(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  return PLUMBING_LINE.some((re) => re.test(t))
}

/**
 * Strip plumbing lines from a round's reasoning before it is shown or stored.
 *
 * Blank-line structure is preserved for the lines that survive, so a genuine
 * multi-paragraph thought still reads as one.
 */
export function cleanVisibleThinking(text: string): string {
  if (!text) return text
  const kept = text
    .split('\n')
    .filter((line) => !isPlumbingThought(line))
    .join('\n')
  return kept
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The live stream, not the stored copy — same lesson as the markup filter, and
 * learned the same way: on the shipped fix, one turn later.
 *
 * `cleanVisibleThinking` runs once per round on the text being STORED. Thinking
 * is yielded token by token, so on 2026-07-28 the fix above was live and his
 * screen still read *"The response already started with the mandatory first line
 * as required."* — the transcript was clean and the screen was not.
 *
 * A thought can only be judged as a LINE (that is what `isPlumbingThought` reads),
 * so this holds the tail until a newline arrives. The visible effect is that
 * reasoning appears line by line instead of character by character, which is the
 * price of not showing him our control notes at all.
 */
export interface ThinkingStreamFilter {
  push(delta: string): string
  flush(): string
}

export function createThinkingStreamFilter(): ThinkingStreamFilter {
  const markup = createMarkupStreamFilter()
  let partial = ''

  const takeLines = (chunk: string, final: boolean): string => {
    partial += chunk
    if (!final && !partial.includes('\n')) return ''
    const pieces = partial.split('\n')
    partial = final ? '' : (pieces.pop() ?? '')
    const kept = pieces.filter((line) => !isPlumbingThought(line))
    if (final && chunk === '' && kept.length === 0) return ''
    return kept.length > 0 ? kept.join('\n') + (final ? '' : '\n') : ''
  }

  return {
    push(delta: string): string {
      return takeLines(markup.push(delta), false)
    },
    flush(): string {
      return takeLines(markup.flush(), true)
    },
  }
}
