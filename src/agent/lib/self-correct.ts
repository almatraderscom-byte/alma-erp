/**
 * Harness Gap 1 — self-correction nudge after failed tool rounds.
 *
 * When one or more tool calls in a round FAIL, the next model round gets one
 * compact, deterministic instruction block telling the head how to recover:
 * read the error, never repeat the identical call, use find_tool if the tool
 * was missing, try a real alternative, or tell the Boss honestly. This turns
 * "tool failed → confused apology" into "tool failed → reasoned retry", for
 * every head model (both loop paths append it the same way).
 *
 * Gated by AGENT_SELF_CORRECT (default ON). The nudge is appended AFTER the
 * cached prefix (end of messages), so prompt-cache bytes are untouched.
 */

export interface FailedToolCall {
  toolName: string
  error: string
}

export function selfCorrectEnabled(): boolean {
  return (process.env.AGENT_SELF_CORRECT ?? '').trim().toLowerCase() !== 'false'
}

/** Max failures listed in one nudge — keeps the block small on chaotic rounds. */
const MAX_LISTED_FAILURES = 3

/**
 * Build the recovery instruction for a round that had failures.
 * Returns null when there is nothing to correct (no failures / flag off).
 */
export function buildSelfCorrectionNudge(failed: FailedToolCall[]): string | null {
  if (!selfCorrectEnabled()) return null
  const real = failed.filter((f) => f.toolName && f.error)
  if (real.length === 0) return null

  const seen = new Set<string>()
  const listed: FailedToolCall[] = []
  for (const f of real) {
    if (seen.has(f.toolName)) continue
    seen.add(f.toolName)
    listed.push(f)
    if (listed.length >= MAX_LISTED_FAILURES) break
  }

  const lines = listed.map(
    (f) => `- ${f.toolName}: ${f.error.slice(0, 200)}`,
  )
  const missingTool = listed.some((f) =>
    /no such tool|unknown tool|tool.*(নেই|পাওয়া যায়নি)|not (available|found)/i.test(f.error),
  )

  return [
    '[self-correction] আগের ধাপে টুল ব্যর্থ হয়েছে:',
    ...lines,
    'নিয়ম: (১) error-টা পড়ে কারণ বোঝো; (২) হুবহু একই call আবার দিও না;',
    missingTool
      ? '(৩) টুলটা তোমার list-এ নেই — find_tool দিয়ে খুঁজে নাও, পাওয়া গেলে সেটা load হয়ে যাবে;'
      : '(৩) input বদলে বা বিকল্প টুল দিয়ে আবার চেষ্টা করো;',
    '(৪) সত্যিই সম্ভব না হলে Boss-কে সরাসরি বলো কী পারলে না ও কেন — ভান কোরো না।',
  ].join('\n')
}
