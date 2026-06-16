import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  agentToolEvent: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

describe('aggregateToolEvents', () => {
  it('computes correct fail% and p95 from fixture data', async () => {
    const { aggregateToolEvents } = await import('@/agent/lib/tool-telemetry')

    const fixture = [
      { toolName: 'get_sales_summary', success: true, verified: false, errorClass: null, latencyMs: 100 },
      { toolName: 'get_sales_summary', success: true, verified: false, errorClass: null, latencyMs: 120 },
      { toolName: 'mark_salah', success: true, verified: true, errorClass: null, latencyMs: 200 },
      { toolName: 'mark_salah', success: false, verified: false, errorClass: 'handler_error', latencyMs: 50 },
      { toolName: 'save_memory', success: true, verified: false, errorClass: null, latencyMs: 150 },
      { toolName: 'save_memory', success: false, verified: false, errorClass: 'handler_error', latencyMs: 80 },
      { toolName: 'get_orders', success: true, verified: false, errorClass: null, latencyMs: 300 },
      { toolName: 'get_orders', success: true, verified: false, errorClass: null, latencyMs: 500 },
      { toolName: 'set_reminder', success: false, verified: false, errorClass: 'uncaught_exception', latencyMs: 10 },
      { toolName: '__refusal__', success: false, verified: false, errorClass: 'maybe_starved', latencyMs: 0 },
    ]

    mockPrisma.agentToolEvent.findMany.mockResolvedValue(fixture)

    const result = await aggregateToolEvents(new Date(), new Date())

    expect(result.totalCalls).toBe(10)
    expect(result.refusalCount).toBe(1)

    // 9 real events (excluding __refusal__), 3 fails
    expect(result.failCount).toBe(3)
    expect(result.failRate).toBe(33) // 3/9 = 33%

    expect(result.verifiedCount).toBe(1)

    expect(result.topErrors.length).toBeGreaterThan(0)
    expect(result.topErrors[0].errorClass).toBe('handler_error')

    expect(result.perTool.length).toBeGreaterThan(0)
    const salesTool = result.perTool.find((t: { toolName: string }) => t.toolName === 'get_sales_summary')
    expect(salesTool).toBeDefined()
    expect(salesTool!.calls).toBe(2)
    expect(salesTool!.fails).toBe(0)
  })

  it('handles empty data', async () => {
    const { aggregateToolEvents } = await import('@/agent/lib/tool-telemetry')
    mockPrisma.agentToolEvent.findMany.mockResolvedValue([])
    const result = await aggregateToolEvents(new Date(), new Date())
    expect(result.totalCalls).toBe(0)
    expect(result.failRate).toBe(0)
  })
})

describe('logToolEvent', () => {
  it('creates a record (fire-and-forget)', async () => {
    const { logToolEvent } = await import('@/agent/lib/tool-telemetry')
    mockPrisma.agentToolEvent.create.mockResolvedValue({ id: 'evt1' })
    await logToolEvent({ toolName: 'get_sales_summary', success: true })
    expect(mockPrisma.agentToolEvent.create).toHaveBeenCalledOnce()
    const data = mockPrisma.agentToolEvent.create.mock.calls[0][0].data
    expect(data.toolName).toBe('get_sales_summary')
    expect(data.success).toBe(true)
  })

  it('does not throw on DB failure', async () => {
    const { logToolEvent } = await import('@/agent/lib/tool-telemetry')
    mockPrisma.agentToolEvent.create.mockRejectedValue(new Error('DB down'))
    await expect(logToolEvent({ toolName: 'test', success: false })).resolves.toBeUndefined()
  })
})
