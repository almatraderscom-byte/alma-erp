/**
 * Reopen-time stall revive (owner incident 2026-08-26).
 *
 * A streamed inline chat turn can go silent mid-run — the provider stream
 * wedges, or the platform kills the function after the client's socket drops.
 * The 75-minute stranded-turn watchdog (turn-watchdog.ts) eventually settles
 * such a corpse, but the owner reopening the app should not stare at "কাজ
 * চলছে" for an hour first: the turn-status poll he lands on IS the moment the
 * server knows someone is looking.
 *
 * So the poll path calls this: an 'inline' turn whose durable log has been
 * silent longer than the revive window is settled with the same claim-first
 * CAS the watchdog uses, and — when the turn left persisted authority behind
 * (workflow event / intake focus / checkpoint) — a source-bound self-continue
 * hop is scheduled so the work RESUMES instead of merely stopping. The hop
 * chain's own brakes (hop budget, dry-hop, halt marker) all apply.
 *
 * Why 'inline' only: inline turns stream dense durable events (thinking
 * deltas, tool markers, progress nudges — multiple per second), so minutes of
 * durable silence means dead with high confidence. Worker/engine slices may
 * legitimately sit quiet inside an hour-long budget — they stay with the
 * watchdog's slice-aware window (effectiveStaleMs).
 */
import { prisma } from '@/lib/prisma'
import { publishTurnTerminal } from '@/agent/lib/turn-watchdog'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const REVIVE_TERMINAL_MESSAGE = 'turn_stalled_stream_lost'
const REVIVE_SILENT_MS_DEFAULT = 180_000
const REVIVE_SILENT_MS_FLOOR = 60_000

export function reviveSilentMs(): number {
  const n = Number(process.env.AGENT_REOPEN_REVIVE_SILENT_MS)
  return Number.isFinite(n) && n >= REVIVE_SILENT_MS_FLOOR ? n : REVIVE_SILENT_MS_DEFAULT
}

export interface ReviveResult {
  revived: boolean
  continuationScheduled: boolean
}

const NONE: ReviveResult = { revived: false, continuationScheduled: false }

/**
 * Settle one silent inline turn and try to resume its work. Never throws —
 * the status poll must answer even when revive plumbing is broken.
 */
export async function reviveStalledInlineTurn(input: {
  turnId: string
  conversationId: string
  now?: Date
}): Promise<ReviveResult> {
  try {
    const now = input.now ?? new Date()
    const turn = await db.agentTurn.findUnique({
      where: { id: input.turnId },
      select: { id: true, conversationId: true, status: true, executionMode: true, startedAt: true },
    })
    if (!turn || turn.status !== 'running') return NONE
    if (turn.conversationId !== input.conversationId) return NONE
    if (turn.executionMode && turn.executionMode !== 'inline') return NONE

    const newest = await db.agentTurnEvent.findFirst({
      where: { turnId: turn.id },
      orderBy: { seq: 'desc' },
      select: { seq: true, createdAt: true },
    })
    const started = new Date(turn.startedAt)
    const lastActivity = newest && new Date(newest.createdAt) > started
      ? new Date(newest.createdAt)
      : started
    if (now.getTime() - lastActivity.getTime() < reviveSilentMs()) return NONE

    // Schedule the resume BEFORE settling: buildSelfContinueBinding requires
    // the source turn to still be running/done, and every #850 brake (hop
    // budget, dry-hop, halt marker, worker-down deferral) applies unchanged.
    // A turn with no persisted authority simply doesn't schedule — the settle
    // below still frees the chat honestly.
    let continuationScheduled = false
    try {
      const { scheduleSelfContinue } = await import('@/agent/lib/self-continue')
      const scheduled = await scheduleSelfContinue({
        conversationId: turn.conversationId,
        sourceTurnId: turn.id,
      })
      continuationScheduled = scheduled.scheduled === true
    } catch (err) {
      console.warn(`[turn-revive] continuation not scheduled for ${turn.id}:`, err instanceof Error ? err.message : err)
    }

    // Claim-first CAS — identical semantics to the watchdog reap: losing the
    // claim means the real executor settled in the meantime, and its own
    // terminal (plus any continuation it scheduled) is the truth.
    // Codex P1 #859: when a continuation WAS queued, the source must settle
    // as 'done', not 'error' — buildSelfContinueBinding and the worker's
    // claimContinuationExecution both revalidate the source status against
    // running/done, so an 'error' source would reject the queued hop with
    // continuation_source_status_mismatch and the work would never resume.
    // This mirrors the deadline salvage, which also ends a continued turn
    // 'done'. Only a dead end (no resume queued) settles as 'error'.
    const settledStatus = continuationScheduled ? 'done' : 'error'
    const claimed = await db.agentTurn.updateMany({
      where: { id: turn.id, status: 'running' },
      data: { status: settledStatus, finishedAt: now },
    })
    if (!claimed?.count) return NONE

    const seq = (newest ? Number(newest.seq) : -1) + 1
    const payload = { type: 'error', message: REVIVE_TERMINAL_MESSAGE }
    let stored = false
    for (let attempt = 0; attempt < 3 && !stored; attempt++) {
      try {
        await db.agentTurnEvent.create({ data: { turnId: turn.id, seq, type: 'error', payload } })
        stored = true
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          // Codex P2 #859: a seq collision means the executor wrote MORE
          // events after our silence read — never stamp lastSeq backwards or
          // publish an event that is not in the durable log. The status
          // claim above already settles pollers; tails settle status-only.
          console.warn(`[turn-revive] seq collision on ${turn.id} — executor wrote after silence read; skipping stamp/publish`)
          return { revived: true, continuationScheduled }
        }
        if (attempt === 2) {
          console.warn(`[turn-revive] terminal event store failed for ${turn.id}:`, err instanceof Error ? err.message : err)
          return { revived: true, continuationScheduled }
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
    await db.agentTurn.updateMany({ where: { id: turn.id }, data: { lastSeq: seq } }).catch(() => {})
    await publishTurnTerminal(turn.id, seq, payload)
    console.warn(`[turn-revive] settled silent inline turn ${turn.id} as ${settledStatus} (last activity ${lastActivity.toISOString()}, continuation=${continuationScheduled})`)
    return { revived: true, continuationScheduled }
  } catch (err) {
    console.warn('[turn-revive] revive failed:', err instanceof Error ? err.message : err)
    return NONE
  }
}
