/**
 * Durable server-side resume (2026-08-24, fix 2 of the long-job continuation
 * program). The deadline salvage used to end with a CLIENT-driven needContinue
 * hint plus "continue বললে…" — a backgrounded/closed app meant the job died at
 * the serverless deadline. The salvage now (a) writes the work-remaining
 * checkpoint the continuation binding requires, (b) schedules the bounded
 * server-side hop through the SAME source-binding contract, and (c) hands the
 * resume to the client only when the server could not schedule.
 *
 * The full generator needs a live provider to reach its abort path, so this is
 * a source-contract test in the file's own established style (see
 * run-owner-turn-continuation-routing.test.ts); the end-to-end proof is the
 * live sim run in docs/proofs/long-job-continuation/.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../run-owner-turn.ts', import.meta.url), 'utf8')

describe('deadline-salvage server-side resume wiring', () => {
  it('schedules the server-side hop from the deadline salvage with measured progress', () => {
    const salvage = source.slice(source.indexOf('if (signal?.aborted) {'))
    const scheduleAt = salvage.indexOf('serverResumeWake = await scheduleSelfContinue({')
    expect(scheduleAt).toBeGreaterThan(-1)
    // Bounded by the same brakes: measured progress rides along.
    expect(salvage.slice(scheduleAt, scheduleAt + 400)).toContain('successfulToolResults: okSteps')
    // Gate: the policy decision, not ad-hoc conditions.
    expect(salvage).toContain("shouldAutoContinueTurn({ deadlineHit: true, hasAskCard: false, tools: toolRecords })")
  })

  it('persists the work-remaining checkpoint BEFORE scheduling (binding authority)', () => {
    const salvage = source.slice(source.indexOf('if (signal?.aborted) {'))
    const checkpointAt = salvage.indexOf('await writeCheckpoint({')
    const scheduleAt = salvage.indexOf('serverResumeWake = await scheduleSelfContinue({')
    expect(checkpointAt).toBeGreaterThan(-1)
    expect(checkpointAt).toBeLessThan(scheduleAt)
    expect(salvage.slice(checkpointAt, scheduleAt)).toContain("taskRef: turnId")
  })

  it('a server-scheduled wake owns the resume — the client hint turns off', () => {
    const salvage = source.slice(source.indexOf('if (signal?.aborted) {'))
    expect(salvage).toContain("let needContinue = serverResumeWake?.scheduled\n            ? false")
  })

  it('the scheduling site of the normal path feeds the dry-hop brake with real progress', () => {
    const site = source.indexOf('if (taskUnfinished) {\n      const { scheduleSelfContinue }')
    expect(site).toBeGreaterThan(-1)
    expect(source.slice(site, site + 700)).toContain(
      "successfulToolResults: toolRecords.filter((r) => r.status === 'success').length",
    )
  })

  it('a genuine owner message resets the chain; engine directives never do', () => {
    expect(source).toContain('resetSelfContinueChain(conversationId)')
    expect(source).toContain('isEngineDirectiveText(lastUserText)')
  })

  it('both authority-guard sites halt the chain durably', () => {
    const matches = source.match(/haltSelfContinueChain\(conversationId/g) ?? []
    expect(matches.length).toBe(2)
  })
})
