import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadConfig() {
  vi.resetModules()
  return await import('@/agent/config')
}

describe('parity flags — Vercel preview auto-enable (production-safe)', () => {
  it('production: plan tracking is ON while the remaining opt-in flags stay OFF', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const c = await loadConfig()
    expect(c.AGENT_CONSTITUTION).toBe(false)
    expect(c.AGENT_UNIFORM_SAMPLING).toBe(false)
    expect(c.AGENT_PLAN_GATE).toBe(true)
    expect(c.AGENT_GROUNDING_GATE).toBe(false)
    expect(c.AGENT_FACT_GATE).toBe(false)
  })

  it('preview: opt-in parity flags auto-ON so the owner can feel the difference', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    const c = await loadConfig()
    expect(c.AGENT_CONSTITUTION).toBe(true)
    expect(c.AGENT_UNIFORM_SAMPLING).toBe(true)
    expect(c.AGENT_PLAN_GATE).toBe(true)
    expect(c.AGENT_GROUNDING_GATE).toBe(true)
    expect(c.AGENT_FACT_GATE).toBe(true)
  })

  it('preview: an explicit <FLAG>=off still wins', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('AGENT_GROUNDING_GATE', 'off')
    vi.stubEnv('AGENT_PLAN_GATE', 'off')
    const c = await loadConfig()
    expect(c.AGENT_GROUNDING_GATE).toBe(false)
    expect(c.AGENT_PLAN_GATE).toBe(false)
    expect(c.AGENT_CONSTITUTION).toBe(true)
  })
})
