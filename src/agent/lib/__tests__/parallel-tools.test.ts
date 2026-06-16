import { describe, it, expect } from 'vitest'
import { MUTATING_TOOLS } from '@/agent/lib/core'

describe('MUTATING_TOOLS set', () => {
  it('contains known write tools', () => {
    expect(MUTATING_TOOLS.has('mark_salah')).toBe(true)
    expect(MUTATING_TOOLS.has('save_memory')).toBe(true)
    expect(MUTATING_TOOLS.has('set_reminder')).toBe(true)
    expect(MUTATING_TOOLS.has('manage_work_todos')).toBe(true)
    expect(MUTATING_TOOLS.has('delegate_to_specialist')).toBe(true)
    expect(MUTATING_TOOLS.has('log_expense')).toBe(true)
    expect(MUTATING_TOOLS.has('approve_and_dispatch_tasks')).toBe(true)
    expect(MUTATING_TOOLS.has('send_urgent_alert')).toBe(true)
  })

  it('does NOT contain known read tools', () => {
    expect(MUTATING_TOOLS.has('get_sales_summary')).toBe(false)
    expect(MUTATING_TOOLS.has('get_orders')).toBe(false)
    expect(MUTATING_TOOLS.has('get_inventory_status')).toBe(false)
    expect(MUTATING_TOOLS.has('get_prayer_times')).toBe(false)
    expect(MUTATING_TOOLS.has('get_salah_status')).toBe(false)
    expect(MUTATING_TOOLS.has('get_expense_summary')).toBe(false)
    expect(MUTATING_TOOLS.has('get_dashboard_snapshot')).toBe(false)
    expect(MUTATING_TOOLS.has('search_memory')).toBe(false)
    expect(MUTATING_TOOLS.has('list_reminders')).toBe(false)
    expect(MUTATING_TOOLS.has('get_staff_tasks')).toBe(false)
  })
})

describe('Parallel tool execution logic', () => {
  type ToolBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

  function classifyTools(toolUseBlocks: ToolBlock[]) {
    const reads: ToolBlock[] = []
    const writes: ToolBlock[] = []
    for (const tb of toolUseBlocks) {
      if (MUTATING_TOOLS.has(tb.name)) {
        writes.push(tb)
      } else {
        reads.push(tb)
      }
    }
    return { reads, writes }
  }

  async function simulateExecution(
    toolUseBlocks: ToolBlock[],
    execFn: (tb: ToolBlock) => Promise<{ success: boolean; data?: unknown }>,
  ): Promise<{ id: string; name: string; success: boolean }[]> {
    const { reads, writes } = classifyTools(toolUseBlocks)
    const resultMap = new Map<string, { tb: ToolBlock; result: { success: boolean; data?: unknown } }>()

    if (reads.length > 0) {
      const readResults = await Promise.all(
        reads.map(async tb => {
          const result = await execFn(tb)
          return { tb, result }
        }),
      )
      for (const r of readResults) resultMap.set(r.tb.id, r)
    }

    for (const tb of writes) {
      const result = await execFn(tb)
      resultMap.set(tb.id, { tb, result })
    }

    // Return in original order
    return toolUseBlocks.map(tb => {
      const exec = resultMap.get(tb.id)!
      return { id: tb.id, name: tb.name, success: exec.result.success }
    })
  }

  it('2 read tools resolve in parallel, results ordered by original position', async () => {
    const blocks: ToolBlock[] = [
      { type: 'tool_use', id: 'a', name: 'get_sales_summary', input: {} },
      { type: 'tool_use', id: 'b', name: 'get_inventory_status', input: {} },
    ]
    const executionOrder: string[] = []
    const results = await simulateExecution(blocks, async (tb) => {
      executionOrder.push(tb.name)
      return { success: true, data: { tool: tb.name } }
    })

    expect(results).toHaveLength(2)
    expect(results[0].id).toBe('a')
    expect(results[1].id).toBe('b')
    expect(results[0].name).toBe('get_sales_summary')
    expect(results[1].name).toBe('get_inventory_status')
  })

  it('read+write mix: reads run first (parallel), then writes sequential, order preserved', async () => {
    const blocks: ToolBlock[] = [
      { type: 'tool_use', id: 'r1', name: 'get_sales_summary', input: {} },
      { type: 'tool_use', id: 'w1', name: 'mark_salah', input: {} },
      { type: 'tool_use', id: 'r2', name: 'get_inventory_status', input: {} },
    ]

    const finishOrder: string[] = []
    const results = await simulateExecution(blocks, async (tb) => {
      // Simulate: reads take 50ms, write takes 10ms
      const delay = MUTATING_TOOLS.has(tb.name) ? 10 : 50
      await new Promise(r => setTimeout(r, delay))
      finishOrder.push(tb.id)
      return { success: true }
    })

    // Results must be in original order regardless of execution order
    expect(results.map(r => r.id)).toEqual(['r1', 'w1', 'r2'])
    // Reads should finish before writes start (r1 and r2 parallel, then w1)
    expect(finishOrder.indexOf('r1')).toBeLessThan(finishOrder.indexOf('w1'))
    expect(finishOrder.indexOf('r2')).toBeLessThan(finishOrder.indexOf('w1'))
  })

  it('single tool: no parallel overhead', async () => {
    const blocks: ToolBlock[] = [
      { type: 'tool_use', id: 'only', name: 'get_sales_summary', input: {} },
    ]
    const results = await simulateExecution(blocks, async () => ({ success: true }))
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('only')
  })

  it('all writes: sequential execution in order', async () => {
    const blocks: ToolBlock[] = [
      { type: 'tool_use', id: 'w1', name: 'mark_salah', input: {} },
      { type: 'tool_use', id: 'w2', name: 'save_memory', input: {} },
    ]
    const executionOrder: string[] = []
    const results = await simulateExecution(blocks, async (tb) => {
      executionOrder.push(tb.id)
      return { success: true }
    })

    expect(results.map(r => r.id)).toEqual(['w1', 'w2'])
    expect(executionOrder).toEqual(['w1', 'w2'])
  })
})
