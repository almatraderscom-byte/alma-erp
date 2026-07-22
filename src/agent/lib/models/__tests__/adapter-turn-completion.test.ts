import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '@/agent/lib/models/registry'

const mocks = vi.hoisted(() => ({
  turns: [] as Array<Array<Record<string, unknown>>>,
  requests: [] as Array<Record<string, unknown>>,
  executeTool: vi.fn(async () => ({ success: true, data: { checked: true } })),
}))

vi.mock('@/agent/lib/models/adapters', () => ({
  adapterFor: () => ({
    streamTurn: async function* (request: Record<string, unknown>) {
      mocks.requests.push(request)
      const events = mocks.turns.shift() ?? []
      for (const event of events) yield event
    },
  }),
}))

vi.mock('@/agent/tools/registry', () => ({
  executeTool: mocks.executeTool,
}))

import { runAdapterToolLoop } from '../adapter-turn'

const model = {
  id: 'test-worker',
  label: 'Test Worker',
  provider: 'openrouter',
  apiModel: 'test/worker',
  thinking: 'none',
  supportsTools: true,
  supportsCaching: false,
  contextWindow: 32_000,
  inPerM: 0,
  outPerM: 0,
} as ModelEntry

function run(maxIterations = 1) {
  return runAdapterToolLoop({
    model,
    system: 'test system',
    userTask: 'test task',
    tools: [{ name: 'get_product', description: 'read', schema: { type: 'object' } }],
    maxIterations,
    businessId: 'ALMA_LIFESTYLE',
  })
}

describe('adapter worker completion contract', () => {
  beforeEach(() => {
    mocks.turns = []
    mocks.requests = []
    mocks.executeTool.mockClear()
  })

  it('marks a normal tool-free final answer complete', async () => {
    mocks.turns.push([
      { type: 'text_delta', text: 'সম্পূর্ণ উত্তর' },
      { type: 'usage', inputTokens: 10, outputTokens: 3, cacheRead: 0, cacheWrite: 0 },
    ])
    const result = await run()
    expect(result.completed).toBe(true)
    expect(result.text).toBe('সম্পূর্ণ উত্তর')
    expect(mocks.requests).toHaveLength(1)
  })

  it('does not return pre-tool "let me start" text as the final result', async () => {
    mocks.turns.push(
      [
        { type: 'text_delta', text: 'Let me start by checking.' },
        { type: 'tool_start', id: 'call-1', name: 'get_product' },
        { type: 'tool_input', id: 'call-1', input: { sku: '720' } },
        { type: 'usage', inputTokens: 20, outputTokens: 5, cacheRead: 0, cacheWrite: 0 },
      ],
      [
        { type: 'text_delta', text: 'চেক শেষ; এই ফলটিই সম্পূর্ণ।' },
        { type: 'usage', inputTokens: 8, outputTokens: 4, cacheRead: 0, cacheWrite: 0 },
      ],
    )
    const result = await run(1)
    expect(result.completed).toBe(true)
    expect(result.text).toBe('চেক শেষ; এই ফলটিই সম্পূর্ণ।')
    expect(mocks.executeTool).toHaveBeenCalledTimes(1)
    expect(mocks.requests).toHaveLength(2)
    expect(mocks.requests[1].tools).toEqual([])
  })

  it('reports incomplete when the forced tool-free wrap-up is empty', async () => {
    mocks.turns.push(
      [
        { type: 'tool_start', id: 'call-1', name: 'get_product' },
        { type: 'tool_input', id: 'call-1', input: { sku: '720' } },
      ],
      [],
    )
    const result = await run(1)
    expect(result.completed).toBe(false)
    expect(mocks.requests).toHaveLength(2)
  })
})
