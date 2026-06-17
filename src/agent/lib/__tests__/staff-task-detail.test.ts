import { describe, expect, it } from 'vitest'
import { buildStaffFriendlyDetail } from '@/agent/lib/staff-task-format'

describe('buildStaffFriendlyDetail', () => {
  it('generates 2–3 line Bangla detail with tool name for order_followup', () => {
    const detail = buildStaffFriendlyDetail({
      title: '5টি পেন্ডিং অর্ডার ফলো-আপ',
      type: 'order_followup',
    })
    expect(detail).toContain('ERP')
    expect(detail.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps existing rich detail when tool is already mentioned', () => {
    const existing = 'CapCut দিয়ে রিল বানান।\n১) shoot  ২) edit  ৩) export'
    const detail = buildStaffFriendlyDetail({
      title: 'Test reel',
      type: 'video_reel',
      detail: existing,
    })
    expect(detail).toBe(existing)
  })
})
