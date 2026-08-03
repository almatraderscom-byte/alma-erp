/**
 * P0-2 — the approval wait, split by stage (foundation audit H.5).
 *
 * The stamps are written by three different processes, so they arrive in
 * whatever order the clocks and the network allow. The summariser is what turns
 * that pile into "the queue hop cost 4s and the model cost 61s", so it is the
 * part worth locking down: ordering, gaps, and never throwing on junk.
 */
import { describe, it, expect } from 'vitest'
import { summariseStageTrace } from '@/agent/lib/turn-stage-trace'

const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString()

describe('summariseStageTrace', () => {
  it('orders stamps by time, not by arrival, and derives the gaps', () => {
    // Deliberately out of order: the worker's stamp can land before the
    // approve route's write is visible.
    const split = summariseStageTrace([
      { stage: 'route_received', at: at(5_000) },
      { stage: 'approve_received', at: at(0) },
      { stage: 'first_token', at: at(66_000) },
      { stage: 'continuation_enqueued', at: at(900), detail: 'worker' },
    ])
    expect(split).not.toBeNull()
    expect(split!.stages.map((s) => s.stage)).toEqual([
      'approve_received',
      'continuation_enqueued',
      'route_received',
      'first_token',
    ])
    // This is the number the audit could not produce: the queue hop.
    const hop = split!.gapsMs.find((g) => g.from === 'continuation_enqueued' && g.to === 'route_received')
    expect(hop?.ms).toBe(4_100)
    // …and this is the one it suspected was the bulk of the wait.
    const inference = split!.gapsMs.find((g) => g.from === 'route_received' && g.to === 'first_token')
    expect(inference?.ms).toBe(61_000)
    expect(split!.totalMs).toBe(66_000)
  })

  it('keeps the detail qualifier (which handoff path, which model)', () => {
    const split = summariseStageTrace([
      { stage: 'continuation_enqueued', at: at(0), detail: 'inline' },
      { stage: 'head_resolved', at: at(200), detail: 'gpt-5.6-luna' },
    ])
    expect(split!.stages[0].detail).toBe('inline')
    expect(split!.stages[1].detail).toBe('gpt-5.6-luna')
  })

  it('is null for nothing, and survives junk instead of throwing', () => {
    expect(summariseStageTrace(null)).toBeNull()
    expect(summariseStageTrace([])).toBeNull()
    expect(summariseStageTrace('not a trace')).toBeNull()
    expect(summariseStageTrace([{ stage: 'first_token', at: 'never' }])).toBeNull()
  })

  it('a single stamp has no gaps and no total (an unfinished turn)', () => {
    const split = summariseStageTrace([{ stage: 'approve_received', at: at(0) }])
    expect(split!.gapsMs).toEqual([])
    expect(split!.totalMs).toBeNull()
  })
})
