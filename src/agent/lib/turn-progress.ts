/**
 * "কী হচ্ছে এখন" — a status line during the silence.
 *
 * Owner, 2026-07-27, comparing his agent's flow to mine:
 *
 *   > *"কাজের মাঝখানে ছোট ছোট Update দেওয়া … User যেন সবসময় বুঝতে পারে এখন কী
 *   >  হচ্ছে এবং কোন পর্যায়ে কাজ চলছে।"*
 *
 * I remembered a "progress update every 3 silent rounds" rule shipping here.
 * Checked: it does not exist in the code. What fills that space today is
 * `thinking_delta` — which only appears when the head is a reasoning model. On
 * the non-reasoning paths (a plain DeepSeek/Qwen turn) eight tool rounds render
 * as a spinner and nothing else.
 *
 * ── Why this is code and not a prompt rule ──────────────────────────────────
 *
 * "Tell Boss what you're doing every few steps" is a request a model honours
 * when it feels like it, and a long tool-heavy turn is exactly when models stop
 * feeling like it. The server, on the other hand, KNOWS the round count, the
 * elapsed time and the last tool that ran. So it says so itself. No model
 * cooperation, no drift, and it works identically on every head.
 *
 * Deliberately quiet when the model IS talking: a status line under a stream of
 * live text is noise, and noise is how a real signal gets ignored.
 */

/**
 * Bangla digits, because the rest of his thread already uses them ("৪২টা
 * প্রোডাক্ট") and a lone "3 ধাপ" reads like a bug. The pattern is copied from
 * the office portal rather than invented (`const BN = '০১২৩৪৫৬৭৮৯'`).
 */
const BN_DIGITS = '০১২৩৪৫৬৭৮৯'
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)])

/** Emit at most one status per this many tool rounds. */
export const PROGRESS_EVERY_ROUNDS = 3
/** …and never more often than this, however fast the rounds go. */
export const PROGRESS_MIN_GAP_MS = 15_000

export interface TurnProgressState {
  lastRound: number
  lastAtMs: number
}

export function newTurnProgressState(): TurnProgressState {
  return { lastRound: 0, lastAtMs: 0 }
}

export interface TurnProgressInput {
  /** Completed tool rounds so far this turn. */
  round: number
  /** Has the model produced owner-visible text since the last status? */
  spokeSinceLast: boolean
  /** Milliseconds since the turn started. */
  elapsedMs: number
  /** Label of the most recent tool, for "এখন কী". */
  lastToolLabel: string | null
  nowMs: number
}

export interface TurnProgress {
  round: number
  elapsedSec: number
  lastToolLabel: string | null
  /** Ready-made Bangla line, so every surface renders the same sentence. */
  text: string
}

/**
 * Decide whether to emit, and what. Returns null when the turn is talking,
 * still early, or has just reported.
 *
 * Pure and time-injected so the cadence is testable without waiting 15 seconds.
 */
export function nextTurnProgress(
  state: TurnProgressState,
  input: TurnProgressInput,
): { progress: TurnProgress; state: TurnProgressState } | null {
  // The model is narrating — it is already doing this job better than we can.
  if (input.spokeSinceLast) return null
  if (input.round < state.lastRound + PROGRESS_EVERY_ROUNDS) return null
  if (state.lastAtMs && input.nowMs - state.lastAtMs < PROGRESS_MIN_GAP_MS) return null

  const elapsedSec = Math.max(1, Math.round(input.elapsedMs / 1000))
  const where = input.lastToolLabel ? ` · এখন ${input.lastToolLabel}` : ''
  return {
    progress: {
      round: input.round,
      elapsedSec,
      lastToolLabel: input.lastToolLabel,
      text: `⏳ ${bn(input.round)} ধাপ শেষ · ${bn(elapsedSec)}s${where} — চালিয়ে যাচ্ছি`,
    },
    state: { lastRound: input.round, lastAtMs: input.nowMs },
  }
}
