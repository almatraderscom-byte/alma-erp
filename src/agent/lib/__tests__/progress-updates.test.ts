/**
 * Owner ask 2026-07-26: "ekta part er jnne koyek ta dhap sesh kore amk age update
 * daw, erpor abr onno kaje jaw."
 *
 * Watched live the same day: a turn ran seven tool rounds and spoke once, at the
 * very end. For those minutes Boss had a spinner and no idea what was happening.
 *
 * The prompt already asks for terse narration; that is a request. This is the
 * counting rule that makes it hold, so the test is about the ARITHMETIC of when
 * an update is owed — the part that must not drift.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROGRESS_NUDGES, PROGRESS_UPDATE_EVERY } from '@/agent/config'

/** Mirrors the loop rule in run-owner-turn. */
function simulate(rounds: Array<{ spoke: boolean }>, opts: { nearDeadline?: boolean } = {}) {
  let silent = 0
  let nudges = 0
  const owedAt: number[] = []
  rounds.forEach((r, i) => {
    if (r.spoke) { silent = 0; return }
    silent++
    if (!opts.nearDeadline && silent >= PROGRESS_UPDATE_EVERY && nudges < MAX_PROGRESS_NUDGES) {
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

  it('stops after the cap, however long the job runs', () => {
    expect(simulate(silentRounds(100)).nudges).toBe(MAX_PROGRESS_NUDGES)
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

  it('caps the interruptions so a reply cannot become a commentary', () => {
    expect(MAX_PROGRESS_NUDGES).toBeGreaterThan(0)
    expect(MAX_PROGRESS_NUDGES).toBeLessThanOrEqual(6)
  })
})
