import { describe, it, expect } from 'vitest'
import { ROUTING_DEFAULTS, DEFAULT_HEAD_MODEL_ID, getDefaultHeadModelId } from '@/agent/lib/models/routing-config'
import { getModel, isKnownModelId } from '@/agent/lib/models/registry'

/**
 * Owner rule 2026-07-18: the owner's selected model is the head and does ALL the
 * work. Owner rule 2026-07-31: the default head is GPT-5.6 Luna (replaced Grok
 * 4.20 after OpenAI's 2026-07-30 80% price cut). These lock the default + prove it
 * is a real, head-pickable, tool-using model (a worker-only default would answer from
 * thin air instead of calling tools — the 2026-07-12 salah incident class).
 */
describe('owner default head model', () => {
  it('defaults to GPT-5.6 Luna', () => {
    expect(DEFAULT_HEAD_MODEL_ID).toBe('gpt-5.6-luna')
    expect(ROUTING_DEFAULTS.defaultHeadModelId).toBe('gpt-5.6-luna')
  })

  it('the default head is a known, tool-using, head-pickable model', () => {
    expect(isKnownModelId(DEFAULT_HEAD_MODEL_ID)).toBe(true)
    const m = getModel(DEFAULT_HEAD_MODEL_ID)
    expect(m.supportsTools).toBe(true)
    expect(m.headPickable).not.toBe(false)
  })

  it('getDefaultHeadModelId falls back to Luna when the KV store is unavailable (tests have no DB)', async () => {
    // prisma.agentKvSetting.findUnique throws (no DATABASE_URL) → the reader must
    // swallow it and return the default rather than crash the turn.
    await expect(getDefaultHeadModelId()).resolves.toBe('gpt-5.6-luna')
  })
})
