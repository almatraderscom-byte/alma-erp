/**
 * Long-job execution lane routing (2026-08-24).
 *
 * CLAUDE.md rule: long agentic tasks (>30s) belong on the VPS worker queue,
 * never Vercel functions. Report/audit-class owner turns were still running on
 * the serverless chat route (maxDuration 800s, hard cap ~280–760s), so a real
 * report job died at the deadline, salvaged with "continue বললে…", and the hop
 * chain burned tokens re-climbing the same hill (live runaway 2026-08-24:
 * 12 hops, ~98k tokens, no report).
 *
 * This module holds the DECISION only — pure and unit-testable. The chat route
 * performs the actual enqueue (the same BullMQ `long-agent-task` lane the /turn
 * route already uses) and tails the worker's durable event log back over its
 * own SSE response, so every installed client sees a perfectly ordinary /chat
 * stream while the execution has no serverless deadline under it.
 *
 * Deliberately conservative: only clear report/audit-class asks (or a
 * conversation already remembered as a long_run job) route to the worker.
 * Everything else keeps today's inline path.
 */
import { requiresCompleteReport, EXPLICIT_REPORT_REQUEST } from '@/agent/lib/claim-verifier'
import {
  classifyActionAttemptExpected,
  deriveOwnerTurnRequirements,
} from '@/agent/lib/owner-turn-requirements'

/** Kill switch: set AGENT_LONG_TURN_WORKER_LANE=off to restore inline-only. */
export function longTurnWorkerLaneEnabled(): boolean {
  const v = (process.env.AGENT_LONG_TURN_WORKER_LANE ?? '').trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== '0'
}

/**
 * After an AMBIGUOUS enqueue failure the route fails the turn closed (running
 * inline could double-execute — Codex P1 #850) and tells the owner to re-send.
 * That retry must actually run: this cooldown keeps the conversation off the
 * worker lane briefly, so the retry takes the inline path where no enqueue was
 * ever attempted (unambiguous, safe).
 */
export const LONG_TURN_LANE_COOLDOWN_MS = 10 * 60 * 1000
const COOLDOWN_KEY_PREFIX = 'long_turn_lane_cooldown:'

export async function markLongTurnLaneCooldown(conversationId: string): Promise<void> {
  const { prisma } = await import('@/lib/prisma')
  const key = `${COOLDOWN_KEY_PREFIX}${conversationId}`
  const value = new Date().toISOString()
  await prisma.agentKvSetting
    .upsert({ where: { key }, update: { value }, create: { key, value } })
    .catch(() => {})
}

export async function longTurnLaneCooldownActive(conversationId: string): Promise<boolean> {
  try {
    const { prisma } = await import('@/lib/prisma')
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: `${COOLDOWN_KEY_PREFIX}${conversationId}` },
    })
    if (!row?.value) return false
    const t = Date.parse(String(row.value))
    return Number.isFinite(t) && Date.now() - t < LONG_TURN_LANE_COOLDOWN_MS
  } catch {
    return false
  }
}

/**
 * Is this owner message a report/audit-class long job? High-precision on
 * purpose — a false positive costs a queue hop on a quick answer; a false
 * negative just keeps today's serverless behaviour (with the hop-chain safety
 * net behind it).
 */
export function classifyLongJobOwnerMessage(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // "সম্পূর্ণ/full/professional report" or two named report sections.
  if (requiresCompleteReport(t)) return true
  const req = deriveOwnerTurnRequirements(t)
  // Site audits always end in a client-ready deliverable (owner standing rule).
  if (req.clientSeo || req.reportArtifact) return true
  // An imperative that names a report/audit deliverable ("inventory-র রিপোর্ট
  // দাও", "run a stock audit") — the exact class of the 2026-08-24 runaway.
  if (EXPLICIT_REPORT_REQUEST.test(t) && classifyActionAttemptExpected(t)) return true
  // Explicit deep/full-scope WORK (not a question) is a long job by definition.
  if (req.deepWork && req.actionAttemptExpected) return true
  return false
}

export interface LongTurnLaneInput {
  /** The owner's message for this turn (already trimmed by the route). */
  message: string
  /** The conversation already remembered as a long_run job (turn-work-class). */
  rememberedLongRun: boolean
  /** Route facts — any true disqualifies the handoff. */
  isInternalCall: boolean
  internalControl: boolean
  resume: boolean
  autoContinue: boolean
  voiceTurn: boolean
  streamMode: boolean
}

/**
 * Should THIS turn hand execution to the worker lane? All route-shape guards
 * live here so the decision is one call and one unit test.
 */
export function shouldRouteOwnerTurnToWorker(input: LongTurnLaneInput): boolean {
  if (!longTurnWorkerLaneEnabled()) return false
  if (input.isInternalCall || input.internalControl) return false // the worker's own callback must run inline
  if (input.resume || input.autoContinue) return false // same-turn re-runs stay where they are
  if (input.voiceTurn) return false // voice needs the low-latency inline stream
  if (!input.streamMode) return false // JSON mode (Telegram tests) has no tail
  if (!input.message) return false
  if (input.rememberedLongRun) return true
  return classifyLongJobOwnerMessage(input.message)
}
