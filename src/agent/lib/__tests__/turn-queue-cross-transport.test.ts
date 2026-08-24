/**
 * Codex P1 #850 r7: an HTTP handoff whose response is lost may already have
 * delivered the job to the worker's LOCAL queue; re-submitting the same turn
 * to the separate cloud Redis queue lets both deliveries execute (jobId dedupe
 * only holds within one queue). A caller that fails closed on ambiguity must
 * be able to forbid crossing transports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildTurnJobData, enqueueTurnJob } from '@/agent/lib/turn-queue'

const jobData = buildTurnJobData('turn-1', 'conv-1', { message: 'report দাও' })!

const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.AGENT_TURN_HANDOFF_HTTP = 'on'
  process.env.AGENT_WORKER_DIAGNOSTIC_URL = 'https://worker.invalid'
  process.env.AGENT_INTERNAL_TOKEN = 'test-token'
  delete process.env.LONG_TASK_REDIS_URL
  delete process.env.REDIS_URL
})

afterEach(() => {
  process.env = { ...savedEnv }
  vi.unstubAllGlobals()
})

describe('enqueueTurnJob cross-transport rule', () => {
  it('an ambiguous HTTP failure returns null instead of crossing to Redis when forbidden', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('socket hang up (response lost)') })
    vi.stubGlobal('fetch', fetchMock)

    const jobId = await enqueueTurnJob(jobData, { allowCrossTransportFallback: false })

    expect(jobId).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a successful HTTP handoff returns its job id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ jobId: 'job-42' }),
    })))

    const jobId = await enqueueTurnJob(jobData, { allowCrossTransportFallback: false })

    expect(jobId).toBe('job-42')
  })

  it('with HTTP handoff unconfigured and no Redis there is nothing to enqueue', async () => {
    delete process.env.AGENT_TURN_HANDOFF_HTTP
    const jobId = await enqueueTurnJob(jobData, { allowCrossTransportFallback: false })
    expect(jobId).toBeNull()
  })
})
