/**
 * Dropping Upstash — the HTTP handoff's decision layer.
 *
 * The shared cloud Redis exists for ONE reason: a Vercel function and the VPS
 * cannot see each other's Redis. The VPS has had a token-authenticated HTTP
 * surface all along, so the job can go over that and the worker can enqueue onto
 * its own local Redis.
 *
 * What is locked here is the part that decides — because the failure that would
 * actually hurt is not "HTTP was slow", it is "the handoff quietly reported
 * itself unavailable and a long turn ran inline against a 300s cap", or the
 * reverse: the flag left off and nothing changing at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTurnHandoffConfigured } from '@/agent/lib/turn-queue'

const ENV_KEYS = [
  'AGENT_TURN_HANDOFF_HTTP',
  'AGENT_WORKER_DIAGNOSTIC_URL',
  'AGENT_INTERNAL_TOKEN',
  'LONG_TASK_REDIS_URL',
  'REDIS_URL',
] as const

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const v = values[key]
    if (v === undefined) vi.stubEnv(key, '')
    else vi.stubEnv(key, v)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('is a handoff available at all', () => {
  it('yes over the shared Redis — today, unchanged', () => {
    setEnv({ LONG_TASK_REDIS_URL: 'rediss://upstash' })
    expect(isTurnHandoffConfigured()).toBe(true)
  })

  it('yes over HTTP with NO Redis anywhere — the point of the change', () => {
    setEnv({
      AGENT_TURN_HANDOFF_HTTP: 'on',
      AGENT_WORKER_DIAGNOSTIC_URL: 'http://31.97.237.40:3098',
      AGENT_INTERNAL_TOKEN: 'secret',
    })
    expect(isTurnHandoffConfigured()).toBe(true)
  })

  it('no when nothing is configured — the caller must run inline, not pretend', () => {
    setEnv({})
    expect(isTurnHandoffConfigured()).toBe(false)
  })
})

describe('the flag is the switch, and it is OFF until he flips it', () => {
  it('URL and token present but flag off → HTTP is not used', () => {
    setEnv({
      AGENT_WORKER_DIAGNOSTIC_URL: 'http://31.97.237.40:3098',
      AGENT_INTERNAL_TOKEN: 'secret',
    })
    // Nothing else configured, so a `true` here could only come from the HTTP
    // path being live without being asked for.
    expect(isTurnHandoffConfigured()).toBe(false)
  })

  it('flag on but the token missing → not used; a half-configured handoff is not a handoff', () => {
    setEnv({
      AGENT_TURN_HANDOFF_HTTP: 'on',
      AGENT_WORKER_DIAGNOSTIC_URL: 'http://31.97.237.40:3098',
    })
    expect(isTurnHandoffConfigured()).toBe(false)
  })

  it('flag on but the worker URL missing → not used', () => {
    setEnv({ AGENT_TURN_HANDOFF_HTTP: 'on', AGENT_INTERNAL_TOKEN: 'secret' })
    expect(isTurnHandoffConfigured()).toBe(false)
  })
})
