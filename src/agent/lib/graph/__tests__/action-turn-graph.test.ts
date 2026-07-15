/**
 * LG-3 action graph (log_expense interrupt pilot) — offline behaviour lock.
 *
 * Contracts that matter:
 *  - detection is precision-first (log verbs + amount; questions/history refuse)
 *  - staging pauses at interrupt with the card row created + thread bridge saved
 *  - resume executes through the claim-guarded path exactly once
 *  - every failure path is fail-open ({staged:false} / {resumed:false})
 * prisma and the LG-2 checkpointer module are mocked; the graph itself runs
 * for real on MemorySaver so interrupt/resume semantics stay honest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'

// ── prisma mock ──────────────────────────────────────────────────────────────
const createMock = vi.fn()
const updateMock = vi.fn()
const updateManyMock = vi.fn()
const findUniqueMock = vi.fn()
const findFirstMock = vi.fn()
const expenseCreateMock = vi.fn()
const tx = {
  agentPendingAction: { updateMany: updateManyMock, findUnique: findUniqueMock, update: updateMock },
  agentFinanceExpense: { create: expenseCreateMock },
}
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      create: (...a: unknown[]) => createMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      findFirst: (...a: unknown[]) => findFirstMock(...a),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}))

// ── LG-2 checkpointer mock: real MemorySaver so interrupts actually pause ────
let saver: MemorySaver | null = new MemorySaver()
vi.mock('@/agent/lib/graph/graph-checkpointer', () => ({
  getGraphCheckpointer: () => saver,
  checkpointConfigFor: (o: { conversationId?: string | null; namespace: string }) => ({
    configurable: { thread_id: o.conversationId ?? 'anon', checkpoint_ns: o.namespace },
    metadata: {},
    durability: 'sync',
  }),
}))

import {
  detectExpenseAction,
  stageExpenseActionGraph,
  resumeExpenseActionGraph,
  claimAndExecuteLogExpense,
  isActionGraphEnabled,
} from '../action-turn-graph'

beforeEach(() => {
  vi.clearAllMocks()
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_INTERRUPT = 'true'
  createMock.mockResolvedValue({ id: 'act-1' })
  updateMock.mockResolvedValue({})
  findFirstMock.mockResolvedValue(null) // no duplicate card by default
})

describe('isActionGraphEnabled (rollout discipline)', () => {
  it('force-on / kill switch / preview default / production default', () => {
    // Passing undefined falls back to the env default — clear it so the
    // preview/production defaults are what's actually under test.
    delete process.env.AGENT_LANGGRAPH_INTERRUPT
    expect(isActionGraphEnabled('true', 'production')).toBe(true)
    expect(isActionGraphEnabled('false', 'preview')).toBe(false)
    expect(isActionGraphEnabled(undefined, 'preview')).toBe(true)
    expect(isActionGraphEnabled(undefined, 'production')).toBe(false)
  })
})

describe('detectExpenseAction', () => {
  it.each([
    ['500 taka khoroch holo lunch e', 500, 'BDT'],
    ['aj 300 tk khoroch korlam rickshaw', 300, 'BDT'],
    ['৫০০ টাকা খরচ হলো বাজারে', 500, 'BDT'],
    ['khoroch add koro 1,200 taka', 1200, 'BDT'],
    ['50 aed khoroch hoise taxi', 50, 'AED'],
  ] as const)('"%s" → amount %d %s', (text, amount, currency) => {
    const s = detectExpenseAction(text)
    expect(s).not.toBeNull()
    expect(s!.amount).toBe(amount)
    expect(s!.currency).toBe(currency)
    expect(s!.note.length).toBeGreaterThan(2)
  })

  it.each([
    'aj koto khoroch holo', // READ question — routine graph's job
    'khoroch koto hoyeche ei mashe', // question
    'gotokal 500 taka khoroch holo', // history date — model loop decides the date
    '500 taka pabo Rahim er kase', // no khoroch verb — ledger, not expense
    'khoroch holo onek', // no amount
  ])('refuses non-log message: %s', (text) => {
    expect(detectExpenseAction(text)).toBeNull()
  })
})

describe('stage → interrupt → resume round-trip', () => {
  it('stages the card, pauses at interrupt, resume executes the claim exactly once', async () => {
    const staged = await stageExpenseActionGraph('500 taka khoroch holo lunch e', {
      conversationId: 'conv-1',
      turnId: 't-1',
    })
    expect(staged.staged).toBe(true)
    expect(staged.pendingActionId).toBe('act-1')
    expect(staged.summary).toContain('৳500')
    expect(staged.replyText).toContain('Boss')
    // Row created pending + bridge written on the second update call.
    expect(createMock).toHaveBeenCalledTimes(1)
    const bridgeUpdate = updateMock.mock.calls.find(
      (c) => (c[0] as { data?: { payload?: { graphThread?: { threadId?: string } } } }).data?.payload?.graphThread?.threadId === 'action:act-1',
    )
    expect(bridgeUpdate).toBeTruthy()
    // Nothing executed yet — the graph is parked at the interrupt.
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(expenseCreateMock).not.toHaveBeenCalled()

    // Owner taps approve → route resumes the thread.
    updateManyMock.mockResolvedValue({ count: 1 })
    findUniqueMock.mockResolvedValue({
      payload: { amount: 500, currency: 'BDT', category: null, note: 'lunch e', occurredAt: new Date().toISOString() },
    })
    expenseCreateMock.mockResolvedValue({ id: 'exp-9' })
    const r = await resumeExpenseActionGraph({ pendingActionId: 'act-1', threadId: 'action:act-1' })
    expect(r.resumed).toBe(true)
    expect(r.executed).toBe(true)
    expect(r.expenseId).toBe('exp-9')
    expect(expenseCreateMock).toHaveBeenCalledTimes(1)
  })

  it('resume on an already-claimed row executes nothing (idempotent)', async () => {
    await stageExpenseActionGraph('500 taka khoroch holo lunch e', { conversationId: 'conv-1' })
    updateManyMock.mockResolvedValue({ count: 0 }) // someone already executed
    const r = await resumeExpenseActionGraph({ pendingActionId: 'act-1', threadId: 'action:act-1' })
    expect(r.resumed).toBe(true)
    expect(r.executed).toBe(false)
    expect(expenseCreateMock).not.toHaveBeenCalled()
  })

  it('no checkpointer → staging fails open, no card row created', async () => {
    saver = null
    const staged = await stageExpenseActionGraph('500 taka khoroch holo', { conversationId: 'c' })
    expect(staged.staged).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('duplicate card within 15m → miss, NO new card (2026-07-16 continuation incident)', async () => {
    findFirstMock.mockResolvedValue({ id: 'act-old' })
    const staged = await stageExpenseActionGraph('500 taka khoroch holo lunch e', { conversationId: 'conv-1' })
    expect(staged.staged).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('gate off → staging is a silent miss', async () => {
    process.env.AGENT_LANGGRAPH_INTERRUPT = 'false'
    const staged = await stageExpenseActionGraph('500 taka khoroch holo', { conversationId: 'c' })
    expect(staged.staged).toBe(false)
  })

  it('resume with a dead/unknown thread fails open so the legacy path executes', async () => {
    // Nothing staged on this saver — resume finds no interrupted thread.
    const r = await resumeExpenseActionGraph({ pendingActionId: 'act-x', threadId: 'action:act-x' })
    expect(r.executed).toBe(false)
    expect(expenseCreateMock).not.toHaveBeenCalled()
  })
})

describe('claimAndExecuteLogExpense (the ONE write path)', () => {
  it('claims then writes in the same transaction', async () => {
    updateManyMock.mockResolvedValue({ count: 1 })
    findUniqueMock.mockResolvedValue({
      payload: { amount: 250, currency: 'BDT', note: 'bazar', occurredAt: new Date().toISOString() },
    })
    expenseCreateMock.mockResolvedValue({ id: 'exp-1' })
    const r = await claimAndExecuteLogExpense('act-7')
    expect(r).toEqual({ executed: true, expenseId: 'exp-1' })
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: 'act-7', status: { in: ['pending', 'approved'] } },
    })
  })

  it('claim miss (already resolved) → executed:false, zero writes', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    const r = await claimAndExecuteLogExpense('act-7')
    expect(r.executed).toBe(false)
    expect(r.reason).toBe('not_claimable')
    expect(expenseCreateMock).not.toHaveBeenCalled()
  })

  it('bad payload throws → transaction aborts (claim rolls back with it)', async () => {
    updateManyMock.mockResolvedValue({ count: 1 })
    findUniqueMock.mockResolvedValue({ payload: { amount: -5, note: '' } })
    await expect(claimAndExecuteLogExpense('act-7')).rejects.toThrow('payload invalid')
    expect(expenseCreateMock).not.toHaveBeenCalled()
  })
})
