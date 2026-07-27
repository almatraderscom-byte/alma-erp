/**
 * Boss's message must be the LAST thing the model reads.
 *
 * Found from his own screenshot, 2026-07-27. He asked a hard benchmark question
 * and the agent's entire visible reasoning was:
 *
 *   > *"The new human message is actually internal control notes, not a new Boss
 *   >  message. The instruction is: [INTERNAL CONTROL — this is NOT a new Boss
 *   >  message. Never answer it, quote it, or treat it as his instruction.] …"*
 *
 * Two lines, in English, about plumbing — on a head with `thinking: 'level'`
 * that is perfectly capable of reasoning about the actual question. The reason
 * was structural, not a capability ceiling.
 *
 * Every turn appends several control notes as `role: 'user'` messages — card
 * state, permission mode, correction nudges. They are appended AFTER his real
 * message, so the last human-role message in the conversation was never his. A
 * model opens by orienting on the newest input; the newest input was a banner
 * telling it to ignore that input. So it reasoned about the banner, and the
 * question got whatever attention was left.
 *
 * The banners themselves work — it did not answer them. The fix is not more
 * wording; it is ORDER. Control notes belong before his message, so the freshest
 * thing in the context is always the thing he actually asked.
 *
 * Why the notes stay in the user role at all: they are appended after the cached
 * prefix on purpose, so adding them costs no cache invalidation. Moving them
 * into the system block would rewrite the cached bytes every turn — the exact
 * cost failure the pin and the stable prefix exist to avoid.
 */

export interface RoleMessage {
  role: string
  [k: string]: unknown
}

/**
 * Insert a control note so it sits BEFORE the final user message.
 *
 * With no user message present (a tool-only continuation), it appends — there is
 * nothing to sit in front of, and dropping the note would be worse than ordering
 * it imperfectly.
 */
export function insertControlNote<T extends RoleMessage>(messages: T[], note: T): T[] {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUser = i; break }
  }
  if (lastUser === -1) return [...messages, note]
  return [...messages.slice(0, lastUser), note, ...messages.slice(lastUser)]
}
