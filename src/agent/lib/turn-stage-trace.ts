/**
 * Where the approval minute actually goes — owner, 2026-08-02 (audit P0-2, H.5).
 *
 * Boss taps Approve, sees "⏳ অনুমোদন পেলাম…" instantly, and then waits 60–90
 * seconds in silence. The audit traced the path but could not attribute the
 * time, because it crosses three processes:
 *
 *   Vercel approve route → Redis (Upstash) → VPS worker pickup → chat route
 *   → prompt rebuild → model inference → tool loop → reply
 *
 * Cutting before measuring would be guessing at which of those to cut. So every
 * stage stamps itself on the turn row, append-only, and the split becomes a read.
 * The append is ONE atomic SQL statement (`jsonb ||`) precisely because the
 * writers are different processes — a read-modify-write would silently drop
 * whichever stamp lost the race.
 *
 * Not to be confused with `turn-trace.ts`, which assembles the DECISION lineage
 * (which guard, which tool, what it cost) from rows that already exist. This one
 * measures wall-clock across process boundaries, which nothing recorded before.
 *
 * Fail-open everywhere: a trace is diagnostics. Losing one must never cost a
 * turn, so every function here swallows its errors.
 */
import { prisma } from '@/lib/prisma'

/** The stages of one approval→reply round trip, in the order they should appear. */
export type TurnStage =
  /** Boss's tap reached the approve route. */
  | 'approve_received'
  /** The instant "I got it" line is in the conversation. */
  | 'ack_posted'
  /** The continuation was handed off — `detail` says which path (worker/inline). */
  | 'continuation_enqueued'
  /** The chat route began this turn (inline, or the worker's HTTP call landing). */
  | 'route_received'
  /** The head model was chosen — everything after this is prompt + inference. */
  | 'head_resolved'
  /** First streamed text of the reply — what Boss perceives as "it moved". */
  | 'first_token'
  /** The turn reached a terminal state. */
  | 'turn_done'

export interface TurnStageEntry {
  stage: TurnStage
  /** ISO timestamp of the stamp. */
  at: string
  /** Free-form qualifier: the handoff path, the model id, an error class. */
  detail?: string
}

/**
 * Append one stage stamp to the turn. Atomic, so stamps written from Vercel and
 * from the VPS worker cannot overwrite each other. Never throws.
 */
export async function traceTurnStage(
  turnId: string | null | undefined,
  stage: TurnStage,
  detail?: string,
  /**
   * When the stamp is written LATER than the moment it describes — the approve
   * route records the tap only after the lookup and the note are done, and that
   * initial slice is part of the wait being measured (review bot, #690).
   */
  at: Date = new Date(),
): Promise<void> {
  if (!turnId) return
  const entry: TurnStageEntry = { stage, at: at.toISOString(), ...(detail ? { detail } : {}) }
  try {
    // agent_turns.id is TEXT, not uuid. Casting the parameter made every append
    // throw `operator does not exist: text = uuid` — swallowed by the catch
    // below, so the instrumentation would have shipped silently dead (review
    // bot, #690). No cast: text = text.
    await prisma.$executeRaw`
      UPDATE agent_turns
      SET stage_trace = COALESCE(stage_trace, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
      WHERE id = ${turnId}
    `
  } catch (err) {
    console.warn('[turn-stage-trace] stamp failed:', err instanceof Error ? err.message : err)
  }
}

export interface TurnStageSplit {
  stages: TurnStageEntry[]
  /** Gap between consecutive stamps — the answer to "which part is slow". */
  gapsMs: Array<{ from: TurnStage; to: TurnStage; ms: number }>
  totalMs: number | null
}

/** Order a raw trace and derive the gaps. Pure — unit-testable without a database. */
export function summariseStageTrace(raw: unknown): TurnStageSplit | null {
  const list = Array.isArray(raw) ? (raw as TurnStageEntry[]) : null
  if (!list || list.length === 0) return null
  const stages = list
    .filter((e): e is TurnStageEntry => Boolean(e) && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (stages.length === 0) return null
  const gapsMs: TurnStageSplit['gapsMs'] = []
  for (let i = 1; i < stages.length; i += 1) {
    gapsMs.push({
      from: stages[i - 1].stage,
      to: stages[i].stage,
      ms: Date.parse(stages[i].at) - Date.parse(stages[i - 1].at),
    })
  }
  const totalMs = stages.length > 1
    ? Date.parse(stages[stages.length - 1].at) - Date.parse(stages[0].at)
    : null
  return { stages, gapsMs, totalMs }
}

/** Load + summarise one turn's stage trace. Fails to null. */
export async function loadStageTrace(turnId: string): Promise<TurnStageSplit | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentTurn.findUnique({
      where: { id: turnId },
      select: { stageTrace: true },
    })
    return summariseStageTrace(row?.stageTrace)
  } catch (err) {
    console.warn('[turn-stage-trace] load failed:', err instanceof Error ? err.message : err)
    return null
  }
}
