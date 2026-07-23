/**
 * Per-turn trace spine assembly (audit P0-1). Prisma is mocked — the assembler
 * is read-only over records the runtime already writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  agentTurn: { findUnique: vi.fn() },
  agentToolEvent: { findMany: vi.fn() },
  agentCostEvent: { findMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))

import { assembleTurnTrace } from '../turn-trace'

const T0 = new Date('2026-07-23T10:00:00Z')
const T1 = new Date('2026-07-23T10:00:30Z')

beforeEach(() => {
  vi.clearAllMocks()
  db.agentTurn.findUnique.mockResolvedValue({
    id: 'turn-1',
    conversationId: 'conv-1',
    status: 'done',
    startedAt: T0,
    finishedAt: T1,
    versions: { prompt: 'p1' },
  })
  db.agentToolEvent.findMany.mockResolvedValue([
    {
      id: 'ev-1', ts: new Date(T0.getTime() + 5000), phase: 'route', toolName: 'pack_select',
      success: true, errorCode: null, latencyMs: 10, detail: {},
    },
    {
      id: 'ev-2', ts: new Date(T0.getTime() + 10_000), phase: 'tool', toolName: 'get_sales_summary',
      success: true, errorCode: null, latencyMs: 900, detail: { guardDecision: 'allow' },
    },
    {
      id: 'ev-3', ts: new Date(T0.getTime() + 12_000), phase: 'tool', toolName: 'send_whatsapp',
      success: false, errorCode: 'needs_approval', latencyMs: 5, detail: { guardReason: 'point_of_risk_approval' },
    },
  ])
  db.agentCostEvent.findMany.mockResolvedValue([
    { id: 'c-1', provider: 'google', costUsd: '0.0005', occurredAt: new Date(T0.getTime() + 20_000) },
  ])
})

describe('assembleTurnTrace (P0-1 decision lineage)', () => {
  it('assembles admission + tool/guard + cost spans under one correlationId', async () => {
    const t = await assembleTurnTrace('turn-1')
    expect(t).not.toBeNull()
    expect(t!.trace.ok).toBe(true)
    if (!t!.trace.ok) return
    const path = t!.trace.trace.componentPath
    expect(path).toContain('admission.turn')
    expect(path).toContain('route.pack_select')
    expect(path).toContain('tool.get_sales_summary')
    expect(path).toContain('tool.send_whatsapp')
    expect(path).toContain('cost.google')
    expect(t!.trace.trace.spans.every((s) => s.correlationId === 'turn-1')).toBe(true)
  })

  it('surfaces guard holds: NEEDS_APPROVAL rolls up + reason codes preserved', async () => {
    const t = await assembleTurnTrace('turn-1')
    expect(t!.guardBlocks).toBe(1)
    if (!t!.trace.ok) return
    expect(t!.trace.trace.status).toBe('needs_approval')
    const held = t!.trace.trace.spans.find((s) => s.component === 'tool.send_whatsapp')
    expect(held?.reasonCodes).toContain('needs_approval')
    expect(held?.reasonCodes).toContain('guard:point_of_risk_approval')
  })

  it('sums cost lineage and counts tool calls', async () => {
    const t = await assembleTurnTrace('turn-1')
    expect(t!.costUsd).toBe(0.0005)
    expect(t!.toolCalls).toBe(3)
    expect(t!.versions).toEqual({ prompt: 'p1' })
  })

  it('fails closed on an unknown turn (null, never a guessed trace)', async () => {
    db.agentTurn.findUnique.mockResolvedValue(null)
    expect(await assembleTurnTrace('nope')).toBeNull()
  })
})
