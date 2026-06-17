import { describe, expect, it } from 'vitest'
import { shouldVerifyTaskType } from '@/agent/lib/task-verification'

describe('shouldVerifyTaskType Phase 2', () => {
  it('office_task is instant — no proof required', async () => {
    expect(await shouldVerifyTaskType('office_task')).toBe(false)
  })

  it('product_photo still requires proof', async () => {
    expect(await shouldVerifyTaskType('product_photo')).toBe(true)
  })
})
