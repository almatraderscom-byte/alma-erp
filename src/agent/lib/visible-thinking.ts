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
