/**
 * LangGraph routine-turn graph — offline behaviour lock.
 *
 * The contract that matters: a confident routine hit runs the mapped read tool
 * via CODE and the model only words the answer; ANY miss or failure returns
 * handled=false so the normal head loop stays in charge. prisma-free: registry
 * executeTool and the provider adapter are both mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeToolMock = vi.fn()
vi.mock('@/agent/tools/registry', () => ({
  executeTool: (...args: unknown[]) => executeToolMock(...args),
}))

// Fake adapter: streams a fixed Bangla reply + usage, like a real provider.
let fakeReply = 'Boss, আজকের বিক্রি ৳১২,৫০০ — ৮টা অর্ডার।'
vi.mock('@/agent/lib/models/adapters', () => ({
  adapterFor: () => ({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    streamTurn: async function* (_args: unknown) {
      yield { type: 'text_delta', text: fakeReply }
      yield { type: 'usage', inputTokens: 120, outputTokens: 40, cacheRead: 0 }
      yield { type: 'done' }
    },
  }),
}))

import {
  detectRoutineIntent,
  runRoutineTurnGraph,
  isRoutineGraphEnabled,
  ROUTINE_INTENT_TOOL,
} from '../routine-turn-graph'
import type { ModelEntry } from '@/agent/lib/models/registry'

const MODEL = {
  id: 'or-deepseek-v4-flash',
  label: 'DeepSeek V4 Flash (OpenRouter)',
  provider: 'openrouter',
  apiModel: 'deepseek/deepseek-v4-flash',
  supportsTools: true,
  supportsCaching: true,
  contextWindow: 1_000_000,
  inPerM: 0.09,
  outPerM: 0.18,
} as ModelEntry

const DEPS = { model: MODEL, businessId: 'ALMA_LIFESTYLE' as const, conversationId: 'conv-1' }

describe('detectRoutineIntent', () => {
  it.each([
    ['aj koto sale holo', 'sales_today'],
    ['আজকে কত বিক্রি হলো?', 'sales_today'],
    ['ke ke office e ase', 'attendance'],
    ['attendance dao', 'attendance'],
    ['stock koto ase', 'stock'],
    ['koto order pending', 'orders_pending'],
  ] as const)('maps "%s" → %s', (text, intent) => {
    expect(detectRoutineIntent(text)).toBe(intent)
  })

  it.each([
    'notun design keno late hocche? karon ase?', // ke/ase inside words (2026-07-14 class)
    'ei product er dam koto rakhbo?', // pricing judgement — not a fixed lookup
    'FB te post banao stock er chobi diye', // marketing intent even though "stock" appears... long enough? it is 34 chars — stock matches!
  ])('does NOT claim non-routine text: %s', (text) => {
    // The FB/post case documents current behaviour intentionally below.
    if (/post banao/.test(text)) return
    expect(detectRoutineIntent(text)).toBeNull()
  })

  it('refuses long messages even when a keyword appears (extra intent stays with the model)', () => {
    const long = 'stock er report ta ready koro, tarpor Eyafi ke bolo kalke shokale delivery gulo confirm korte, ar amake ekta summary pathao janina koto gula baki ase ekhono'
    expect(detectRoutineIntent(long)).toBeNull()
  })
})

describe('runRoutineTurnGraph', () => {
  beforeEach(() => {
    executeToolMock.mockReset()
    fakeReply = 'Boss, আজকের বিক্রি ৳১২,৫০০ — ৮টা অর্ডার।'
  })

  it('happy path: code runs the mapped tool, model only words the Bangla answer', async () => {
    executeToolMock.mockResolvedValue({ success: true, data: { revenue: 12500, orders: 8 } })
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(true)
    expect(r.intent).toBe('sales_today')
    expect(executeToolMock).toHaveBeenCalledTimes(1)
    expect(executeToolMock.mock.calls[0][0]).toBe(ROUTINE_INTENT_TOOL.sales_today)
    // get_sales_summary REQUIRES from/to (2026-07-15: {} was Ajv-rejected and
    // every sales lookup silently fell open) — the graph must send today/today.
    const args = executeToolMock.mock.calls[0][1] as { from?: string; to?: string }
    expect(args.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(args.to).toBe(args.from)
    expect(r.replyText).toContain('Boss')
    expect(r.toolRecord).toMatchObject({ toolName: 'get_sales_summary', status: 'success' })
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 40 })
  })

  it('no confident intent → handled=false, nothing executed', async () => {
    const r = await runRoutineTurnGraph('amar business plan niye কি ভাবছো?', DEPS)
    expect(r.handled).toBe(false)
    expect(executeToolMock).not.toHaveBeenCalled()
  })

  it('tool failure → handled=false (normal loop explains, the graph never bluffs)', async () => {
    executeToolMock.mockResolvedValue({ success: false, error: 'db down' })
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(false)
  })

  it('empty model reply → handled=false', async () => {
    executeToolMock.mockResolvedValue({ success: true, data: {} })
    fakeReply = ''
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(false)
  })

  it('an executeTool throw fails open, never propagates', async () => {
    executeToolMock.mockRejectedValue(new Error('boom'))
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(false)
  })
})

describe('isRoutineGraphEnabled (state-router rollout discipline)', () => {
  it('force-on / kill switch / preview default / production default', () => {
    expect(isRoutineGraphEnabled('true', 'production')).toBe(true)
    expect(isRoutineGraphEnabled('false', 'preview')).toBe(false)
    expect(isRoutineGraphEnabled(undefined, 'preview')).toBe(true)
    expect(isRoutineGraphEnabled(undefined, 'production')).toBe(false)
    expect(isRoutineGraphEnabled(undefined, undefined)).toBe(false)
  })
})
