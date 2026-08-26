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
export const REVIVE_CONTINUED_MESSAGE = 'turn_stalled_continued'
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
      select: { id: true, conversationId: true, status: true, executionMode: true, startedAt: true, lastSeq: true, cancelRequested: true },
    })
    if (!turn || turn.status !== 'running') return NONE
    if (turn.conversationId !== input.conversationId) return NONE
    // Codex P2 #859 r7: a Stop pressed mid-effect deliberately parks the turn
    // 'running' with cancelRequested until the authorized effect drains
    // (live-browser companion). That settlement belongs to the cancellation
    // path — reviving it would replace the owner's requested cancel with a
    // done/error and try to continue work the owner just stopped.
    if (turn.cancelRequested === true) return NONE
    // Codex P1 #859 r4: ONLY explicitly-inline rows. A null mode is not
    // inline — worker-bound continuations are bound without a mode stamp
    // (approval-continuation), and a legitimate worker slice may sit quiet
    // far longer than the inline window. Unknown modes stay with the
    // slice-aware watchdog.
    if (turn.executionMode !== 'inline') return NONE

    const newest = await db.agentTurnEvent.findFirst({
      where: { turnId: turn.id },
      orderBy: { seq: 'desc' },
      select: { seq: true, createdAt: true },
    })
    // Codex P1 #859 r11: a turn with NO durable events is not necessarily
    // dead — the non-stream branch (?stream=false) is stamped 'inline' but
    // never installs the publisher/lease and writes no events at all, so
    // startedAt-only silence would claim it while its generator still runs
    // tools. Event-less turns stay with the watchdog (whose window exceeds
    // every inline budget). Streamed turns emit events within seconds, so
    // this excludes nothing the reviver was built for.
    if (!newest) return NONE
    const lastActivity = new Date(newest.createdAt) > new Date(turn.startedAt)
      ? new Date(newest.createdAt)
      : new Date(turn.startedAt)
    if (now.getTime() - lastActivity.getTime() < reviveSilentMs()) return NONE

    // Claim FIRST (Codex P1 #859 r2): scheduling before the claim let a
    // successor be queued while the real executor could still resume and
    // finish normally — duplicated tool side effects with no way to revoke
    // the queued hop. The CAS claims running→'done' ('done' is what
    // buildSelfContinueBinding and claimContinuationExecution accept for a
    // continuation source — Codex P1 r1); losing it means the executor
    // settled and its own terminal is the truth. If no resume ends up
    // queued, the row is downgraded to an honest 'error' below.
    // Codex P1 #859 r6: the CAS also pins the observed activity — if the
    // executor stamped ANY newer event between our silence read and this
    // claim, lastSeq has advanced and the claim fails, so a demonstrably
    // resumed executor is never settled out from under. (The publisher-side
    // lease + atomic append close the stamp-lag remainder from the other
    // side.)
    const claimed = await db.agentTurn.updateMany({
      // cancelRequested is pinned IN the CAS (Codex P2 #859 r8): a Stop that
      // lands between the read above and this claim parks the turn with the
      // cancellation drain, and the claim must lose to it atomically.
      where: { id: turn.id, status: 'running', lastSeq: turn.lastSeq, cancelRequested: false },
      data: { status: 'done', finishedAt: now },
    })
    if (!claimed?.count) return NONE

    // ATOMIC LOG OWNERSHIP BEFORE ANY SCHEDULING (Codex P1 #859 r10): the
    // executor appends the event row and stamps lastSeq in SEPARATE writes,
    // so the lastSeq pin above can pass while a fresher event already sits in
    // the log. Creating the terminal row at the observed next seq is the
    // atomic verify — P2002 here means the executor demonstrably wrote after
    // the silence read, so the claim is ROLLED BACK and nothing is ever
    // queued (previously the successor was already enqueued by this point).
    // The terminal is provisional 'done' (matching the claimed status) and is
    // rewritten below if no continuation ends up queued.
    const seq = (newest ? Number(newest.seq) : -1) + 1
    let provisionalStored = false
    for (let attempt = 0; attempt < 3 && !provisionalStored; attempt++) {
      try {
        await db.agentTurnEvent.create({
          data: { turnId: turn.id, seq, type: 'done', payload: { type: 'done', message: REVIVE_CONTINUED_MESSAGE } },
        })
        provisionalStored = true
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          await db.agentTurn.updateMany({
            where: { id: turn.id, status: 'done' },
            data: { status: 'running', finishedAt: null },
          }).catch(() => {})
          console.warn(`[turn-revive] seq collision on ${turn.id} — executor wrote after silence read; claim rolled back, nothing scheduled`)
          return NONE
        }
        if (attempt === 2) {
          // The claim stands but the log write is failing: no successor was
          // queued and no durable terminal explains the loss, so 'done'
          // would read as a successful completion — settle the claimed row
          // as an honest error before returning (Codex P2 #859 r12).
          console.warn(`[turn-revive] terminal event store failed for ${turn.id}:`, err instanceof Error ? err.message : err)
          await db.agentTurn.updateMany({
            where: { id: turn.id, status: 'done' },
            data: { status: 'error' },
          }).catch(() => {})
          return { revived: true, continuationScheduled: false }
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }

    // Resume the work when the turn left persisted authority behind
    // (workflow event / intake focus / checkpoint). Every #850 brake (hop
    // budget, dry-hop, halt marker, worker-down deferral) applies unchanged.
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
    const payload = continuationScheduled
      ? { type: 'done', message: REVIVE_CONTINUED_MESSAGE }
      : { type: 'error', message: REVIVE_TERMINAL_MESSAGE }
    if (!continuationScheduled) {
      // Dead end — no resume queued, so 'done' would be a lie. Only our own
      // claim can hold 'done' here, and we own the provisional terminal row —
      // both are downgraded to the honest error (Codex P2 #859 r2 contract:
      // the durable terminal must agree with the settlement).
      await db.agentTurn.updateMany({
        where: { id: turn.id, status: 'done' },
        data: { status: 'error' },
      }).catch(() => {})
      await db.agentTurnEvent.update({
        where: { turnId_seq: { turnId: turn.id, seq } },
        data: { type: 'error', payload },
      }).catch(() => {})
    }
    await db.agentTurn.updateMany({ where: { id: turn.id }, data: { lastSeq: seq } }).catch(() => {})
    await publishTurnTerminal(turn.id, seq, payload)
    console.warn(`[turn-revive] settled silent inline turn ${turn.id} as ${continuationScheduled ? 'done+continued' : 'error'} (last activity ${lastActivity.toISOString()})`)
    return { revived: true, continuationScheduled }
  } catch (err) {
    console.warn('[turn-revive] revive failed:', err instanceof Error ? err.message : err)
    return NONE
  }
}
