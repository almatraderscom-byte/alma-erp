import { describe, it, expect } from 'vitest'
import { pickStepForTool, type AdvanceableStep } from '@/agent/lib/plan-step-advance'

const step = (id: string, status: string, toolName?: string): AdvanceableStep =>
  ({ id, action: id, status, toolName: toolName ?? null })

describe('pickStepForTool', () => {
  it('claims the step that names the tool, wherever it sits', () => {
    const steps = [step('s1', 'done', 'get_orders'), step('s2', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_inventory_status')?.id).toBe('s2')
  })

  it('claims the first open step when it names no tool of its own', () => {
    const steps = [step('s1', 'pending'), step('s2', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_orders')?.id).toBe('s1')
  })

  it('never ticks a step that names a different tool', () => {
    const steps = [step('s1', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_orders')).toBeNull()
  })

  it('returns null when every step is finished', () => {
    expect(pickStepForTool([step('s1', 'done', 'get_orders')], 'get_orders')).toBeNull()
  })

  it('re-claims a step already running (the same tool retried)', () => {
    const steps = [step('s1', 'running', 'get_orders')]
    expect(pickStepForTool(steps, 'get_orders')?.id).toBe('s1')
  })
})
