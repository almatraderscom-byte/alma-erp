/**
 * Owner ask 2026-07-26: "ekta part er jnne koyek ta dhap sesh kore amk age update
 * daw, erpor abr onno kaje jaw."
 *
 * Watched live the same day: a turn ran seven tool rounds and spoke once, at the
 * very end. For those minutes Boss had a spinner and no idea what was happening.
 *
 * Owner report 2026-08-20: the flat four-nudge cap expired ~round 12 of a
 * 61-step ads-manager run and the rest ran silent. The cap now scales with the
 * turn's iteration budget so the cadence holds for the WHOLE job.
 *
 * Owner correction 2026-08-21: count individual TOOL CALLS (steps), not model
 * rounds — a batched round of 10 parallel calls hid 10 steps of silent work
 * behind one tick of the old round counter. "2 ta dhap sesh holei short reply."
 *
 * The prompt already asks for terse narration; that is a request. This is the
 * counting rule that makes it hold, so the test is about the ARITHMETIC of when
 * an update is owed — the part that must not drift.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROGRESS_NUDGES, PROGRESS_UPDATE_EVERY, maxProgressNudgesFor } from '@/agent/config'

/** Mirrors the loop rule in run-owner-turn: steps accumulate per round. */
function simulate(
  rounds: Array<{ toolCalls: number; spoke?: boolean }>,
  opts: { nearDeadline?: boolean; maxIterations?: number } = {},
) {
  // A short silent stretch normally sits inside a larger turn budget — only
  // the long-run tests pin maxIterations to the exact round count.
  const maxIterations = opts.maxIterations ?? Math.max(rounds.length + 1, 8)
  let steps = 0
  let nudges = 0
  const owedAt: number[] = []
  rounds.forEach((r, i) => {
    if (r.spoke) steps = 0
    steps += r.toolCalls
    if (
      !opts.nearDeadline
      && steps >= PROGRESS_UPDATE_EVERY
      && nudges < maxProgressNudgesFor(maxIterations)
      // Codex P1 (#811): a nudge needs a next round to be delivered in —
      // never spend the final iteration on one.
      && i < maxIterations - 1
    ) {
      nudges++
      steps = 0
      owedAt.push(i)
    }
  })
  return { nudges, owedAt }
}

const silentRounds = (n: number, toolCalls = 1) =>
  Array.from({ length: n }, () => ({ toolCalls }))

describe('when an update is owed', () => {
  it('says nothing while fewer steps than the cadence have run', () => {
    expect(simulate(silentRounds(PROGRESS_UPDATE_EVERY - 1)).nudges).toBe(0)
  })

  it('asks once the silent steps reach the threshold', () => {
    expect(simulate(silentRounds(PROGRESS_UPDATE_EVERY)).nudges).toBe(1)
  })

  // Owner live-catch 2026-08-21: one round batching many parallel calls is many
  // steps of silent work — the update is owed after that single round.
  it('a single batched round of many calls owes an update immediately', () => {
    expect(simulate([{ toolCalls: 10 }]).owedAt).toEqual([0])
  })

  it('a round that spoke resets the clock — no nagging mid-conversation', () => {
    // Narrating every round (the ideal voluntary cadence) means the counter
    // never reaches the threshold — the backstop stays silent.
    const rounds = Array.from({ length: 6 }, () => ({ toolCalls: 1, spoke: true }))
    expect(simulate(rounds).nudges).toBe(0)
  })

  // The 2026-08-20 regression: a long-run budget must keep the cadence to the
  // END, never fall silent after a flat handful of nudges.
  it('holds the cadence for the whole of a 120-round long-run budget', () => {
    const { owedAt } = simulate(silentRounds(120), { maxIterations: 120 })
    // The LAST update is owed near the end of the run, not near the start.
    expect(owedAt[owedAt.length - 1]).toBeGreaterThanOrEqual(120 - 1 - PROGRESS_UPDATE_EVERY)
  })

  it('never spends the final round on a nudge — the answer needs it', () => {
    const { owedAt } = simulate(silentRounds(30), { maxIterations: 30 })
    expect(owedAt).not.toContain(30 - 1)
  })

  it('never interrupts near the deadline — the wrap-up needs those rounds', () => {
    expect(simulate(silentRounds(20), { nearDeadline: true }).nudges).toBe(0)
  })
})

describe('the budgets are stated, not guessed', () => {
  it('is exactly the two-step cadence the owner set (env-tunable)', () => {
    expect(PROGRESS_UPDATE_EVERY).toBe(2)
  })

  it('the flat constant survives as the floor for short standard turns', () => {
    expect(MAX_PROGRESS_NUDGES).toBeGreaterThan(0)
    expect(maxProgressNudgesFor(8)).toBeGreaterThanOrEqual(MAX_PROGRESS_NUDGES)
  })

  it('caps at the round budget — one nudge per round is the natural ceiling', () => {
    // Batch-heavy runs owe a nudge nearly every round (Codex P2 #815); the
    // cap must not exhaust before the budget does.
    expect(maxProgressNudgesFor(120)).toBe(120)
  })
})
