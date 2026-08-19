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

  it('never counts plan-control calls as doing the first work step', () => {
    const steps = [step('s1', 'pending')]
    expect(pickStepForTool(steps, 'make_plan')).toBeNull()
    expect(pickStepForTool(steps, 'execute_plan')).toBeNull()
    expect(pickStepForTool(steps, 'get_plan')).toBeNull()
  })

  it('returns null when every step is finished', () => {
    expect(pickStepForTool([step('s1', 'done', 'get_orders')], 'get_orders')).toBeNull()
  })

  it('re-claims a step already running (the same tool retried)', () => {
    const steps = [step('s1', 'running', 'get_orders')]
    expect(pickStepForTool(steps, 'get_orders')?.id).toBe('s1')
  })

  it('leaves a running step running so the chip can show it working', () => {
    // begin → running happens before the tool executes; the picker must still be
    // able to find that step when the same call closes it.
    const steps = [step('s1', 'running', 'get_orders'), step('s2', 'pending')]
    expect(pickStepForTool(steps, 'get_orders')?.status).toBe('running')
  })
})
