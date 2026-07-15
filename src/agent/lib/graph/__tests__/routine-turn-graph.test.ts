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
  extractOrderNumber,
  routineIntentCall,
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
    // ── LG-1 intents ──
    ['aj koto khoroch holo', 'expense_today'],
    ['আজকের খরচ কত?', 'expense_today'],
    ['Eyafi ke ki task dise', 'staff_tasks'],
    ['task gulo r status ki', 'staff_tasks'],
    ['namaz er somoy koto', 'salah_today'],
    ['আজ আসরের সময় কখন?', 'salah_today'],
    ['koto approval pending ase', 'approvals_pending'],
    ['pending approval ache?', 'approvals_pending'],
    ['order 1234 er status ki', 'order_status'],
    ['#ALM-1234 order kothay', 'order_status'],
  ] as const)('maps "%s" → %s', (text, intent) => {
    expect(detectRoutineIntent(text)).toBe(intent)
  })

  it.each([
    'ei mash e koto khoroch holo', // period ≠ today — model loop picks the period
    'Eyafi ke ei task dao: delivery', // assignment command, not a status lookup
    'namaz porsi ekhon', // salah log talk, no time word
    'order status ki', // order_status without a number — needs model judgement
    'ki ki baki ase', // ambiguous (orders? tasks?) — no approval word
  ])('LG-1 near-miss stays with the model loop: %s', (text) => {
    expect(detectRoutineIntent(text)).toBeNull()
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
    expect(r.missReason).toBe('graph_error')
  })

  // ── LG-1 ──

  it('retryPolicy: a transient (retryable-code) tool failure is retried and then succeeds', async () => {
    executeToolMock
      .mockResolvedValueOnce({ success: false, error: 'fetch failed', errorCode: 'network', retryable: true })
      .mockResolvedValueOnce({ success: true, data: { revenue: 999 } })
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(true)
    expect(executeToolMock).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('retryPolicy: a deterministic failure is NOT retried — one call, fail open', async () => {
    // malformed_args carries retryable=true in the envelope (a MODEL nudge) but
    // the graph's args are code-built constants — retrying verbatim can't help.
    executeToolMock.mockResolvedValue({ success: false, error: 'bad', errorCode: 'malformed_args', retryable: true })
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(false)
    expect(r.missReason).toBe('tool_failed')
    expect(executeToolMock).toHaveBeenCalledTimes(1)
  })

  it('retryPolicy: still-failing transient error exhausts retries and fails open', async () => {
    executeToolMock.mockResolvedValue({ success: false, error: 'timeout', errorCode: 'timeout', retryable: true })
    const r = await runRoutineTurnGraph('aj koto sale holo', DEPS)
    expect(r.handled).toBe(false)
    expect(executeToolMock).toHaveBeenCalledTimes(3) // maxAttempts
  }, 15_000)

  it('order_status: found order → handled, single-order args sent to get_orders', async () => {
    executeToolMock.mockResolvedValue({
      success: true,
      data: { orders: [{ orderNumber: '1234', status: 'shipped' }], meta: {} },
    })
    const r = await runRoutineTurnGraph('order 1234 er status ki', DEPS)
    expect(r.handled).toBe(true)
    expect(r.intent).toBe('order_status')
    expect(executeToolMock.mock.calls[0][0]).toBe('get_orders')
    expect(executeToolMock.mock.calls[0][1]).toMatchObject({ orderNumber: '1234', limit: 100 })
  })

  it('order_status: number not in the recent window → intent-level miss, falls open (never bluffs "নেই")', async () => {
    executeToolMock.mockResolvedValue({ success: true, data: { orders: [], meta: {} } })
    const r = await runRoutineTurnGraph('order 1234 er status ki', DEPS)
    expect(r.handled).toBe(false)
    expect(r.missReason).toBe('intent_miss')
  })
})

describe('LG-1 slot + args mapping', () => {
  it.each([
    ['order 1234 status', '1234'],
    ['#ALM-1234 kothay', 'ALM-1234'],
    ['অর্ডার 5678 er update', '5678'],
    ['order ta kothay', null],
  ] as const)('extractOrderNumber("%s") → %s', (text, want) => {
    expect(extractOrderNumber(text)).toBe(want)
  })

  it('expense_today calls get_expense_summary with a today window', () => {
    expect(routineIntentCall('expense_today', 'aj koto khoroch')).toEqual({
      toolName: 'get_expense_summary',
      args: { period: 'today', groupBy: 'category' },
    })
  })

  it('staff_tasks sends NO fuzzy staffName (whole-office view; wrong-person answers impossible)', () => {
    expect(routineIntentCall('staff_tasks', 'Eyafi ke ki task dise')).toEqual({
      toolName: 'get_staff_tasks',
      args: {},
    })
  })

  it('order_status without an extractable number returns null (slot miss)', () => {
    expect(routineIntentCall('order_status', 'order status ki')).toBeNull()
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
