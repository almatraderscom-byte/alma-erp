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
 * The prompt already asks for terse narration; that is a request. This is the
 * counting rule that makes it hold, so the test is about the ARITHMETIC of when
 * an update is owed — the part that must not drift.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROGRESS_NUDGES, PROGRESS_UPDATE_EVERY, maxProgressNudgesFor } from '@/agent/config'

/** Mirrors the loop rule in run-owner-turn. */
function simulate(
  rounds: Array<{ spoke: boolean }>,
  opts: { nearDeadline?: boolean; maxIterations?: number } = {},
) {
  // A short silent stretch normally sits inside a larger turn budget — only
  // the long-run tests pin maxIterations to the exact round count.
  const maxIterations = opts.maxIterations ?? Math.max(rounds.length + 1, 8)
  let silent = 0
  let nudges = 0
  const owedAt: number[] = []
  rounds.forEach((r, i) => {
    if (r.spoke) { silent = 0; return }
    silent++
    if (
      !opts.nearDeadline
      && silent >= PROGRESS_UPDATE_EVERY
      && nudges < maxProgressNudgesFor(maxIterations)
      // Codex P1 (#811): a nudge needs a next round to be delivered in —
      // never spend the final iteration on one.
      && i < maxIterations - 1
    ) {
      nudges++
      silent = 0
      owedAt.push(i)
    }
  })
  return { nudges, owedAt }
}

const silentRounds = (n: number) => Array.from({ length: n }, () => ({ spoke: false }))

describe('when an update is owed', () => {
  it('says nothing for a short turn', () => {
    expect(simulate(silentRounds(PROGRESS_UPDATE_EVERY - 1)).nudges).toBe(0)
  })

  it('asks once the silence reaches the threshold', () => {
    expect(simulate(silentRounds(PROGRESS_UPDATE_EVERY)).nudges).toBe(1)
  })

  // The run he actually watched: seven rounds, one closing sentence.
  it('would have interrupted the seven-round silent turn twice', () => {
    expect(simulate(silentRounds(7)).nudges).toBe(2)
  })

  it('a round that spoke resets the clock — no nagging mid-conversation', () => {
    const rounds = [
      { spoke: false }, { spoke: false }, { spoke: true },
      { spoke: false }, { spoke: false },
    ]
    expect(simulate(rounds).nudges).toBe(0)
  })

  // The 2026-08-20 regression: a long-run budget must keep the cadence to the
  // END, never fall silent after a flat handful of nudges.
  it('holds the cadence for the whole of a 120-round long-run budget', () => {
    const { nudges, owedAt } = simulate(silentRounds(120), { maxIterations: 120 })
    // Every PROGRESS_UPDATE_EVERY silent rounds, except the reserved final one.
    expect(nudges).toBe(Math.floor((120 - 1) / PROGRESS_UPDATE_EVERY))
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
  it('is a few rounds, not one and not ten', () => {
    expect(PROGRESS_UPDATE_EVERY).toBeGreaterThanOrEqual(2)
    expect(PROGRESS_UPDATE_EVERY).toBeLessThanOrEqual(5)
  })

  it('the flat constant survives as the floor for short standard turns', () => {
    expect(MAX_PROGRESS_NUDGES).toBeGreaterThan(0)
    expect(maxProgressNudgesFor(8)).toBe(MAX_PROGRESS_NUDGES)
  })

  it('scales with the budget so a long job cannot outlive its updates', () => {
    expect(maxProgressNudgesFor(120)).toBeGreaterThanOrEqual(Math.ceil(120 / PROGRESS_UPDATE_EVERY))
  })
})
