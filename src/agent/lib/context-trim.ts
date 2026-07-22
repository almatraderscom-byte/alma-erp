/**
 * Harness Gap 4 — history-side tool-result trimming (context editing).
 *
 * Old giant tool results (inventory dumps, page text, camera transcripts) ride
 * the transcript into EVERY later request forever. This trims any persisted
 * tool_result above a threshold when history is rebuilt for the model: head +
 * tail survive (ids, totals and conclusions usually live at the edges), middle
 * collapses to a marker. Deterministic per stored block — the same block always
 * trims to the same bytes, so the prompt-cache prefix stays byte-stable. The
 * CURRENT turn's fresh results are never touched (they aren't history yet).
 *
 * Gated by AGENT_TOOLRESULT_TRIM (default ON; set "false" to kill-switch).
 */

/** Above this many chars a historical tool_result gets trimmed. */
export const TRIM_THRESHOLD_CHARS = 4000
/** How much of the head of the result survives. */
export const TRIM_HEAD_CHARS = 1200
/** How much of the tail survives. */
export const TRIM_TAIL_CHARS = 300

export function contextTrimEnabled(): boolean {
  return (process.env.AGENT_TOOLRESULT_TRIM ?? '').trim().toLowerCase() !== 'false'
}

/**
 * Trim one persisted tool_result content string for model consumption.
 * Under the threshold (or flag off) the content passes through untouched.
 */
export function trimToolResultForHistory(content: string): string {
  if (!contextTrimEnabled()) return content
  if (typeof content !== 'string' || content.length <= TRIM_THRESHOLD_CHARS) return content
  const head = content.slice(0, TRIM_HEAD_CHARS)
  const tail = content.slice(-TRIM_TAIL_CHARS)
  const dropped = content.length - TRIM_HEAD_CHARS - TRIM_TAIL_CHARS
  return `${head}\n…[পুরনো টুল ফলাফলের মাঝের ${dropped} অক্ষর ছেঁটে ফেলা হয়েছে — দরকার হলে টুলটা আবার চালাও]…\n${tail}`
}
