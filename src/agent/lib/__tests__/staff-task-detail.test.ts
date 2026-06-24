import { describe, expect, it } from 'vitest'
import {
  buildStaffFriendlyDetail,
  makeDispatchSafeDetail,
} from '@/agent/lib/staff-task-format'

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

describe('makeDispatchSafeDetail — explanation rides through dispatch', () => {
  const task = { title: '5টি পেন্ডিং অর্ডার ফলো-আপ', type: 'order_followup' as const }

  it('injects the tool keyword when the explanation omits it, so dispatch preserves it', () => {
    const explanation = 'কাস্টমারকে কল করুন।\nকনফার্ম করে নিন।'
    const safe = makeDispatchSafeDetail(task, explanation)

    // Round-trip guarantee: buildStaffFriendlyDetail must KEEP this verbatim (not
    // fall back to the template), which is how the explanation survives dispatch.
    expect(buildStaffFriendlyDetail({ ...task, detail: safe })).toBe(safe)
    expect(safe.toLowerCase()).toContain('erp')
    const lines = safe.split('\n').filter(Boolean).length
    expect(lines).toBeGreaterThanOrEqual(2)
    expect(lines).toBeLessThanOrEqual(4)
  })

  it('keeps an explanation untouched when it already names the tool and fits 2–4 lines', () => {
    const reelTask = { title: 'Test reel', type: 'video_reel' as const }
    const explanation = 'CapCut দিয়ে রিল বানান।\n১) shoot  ২) edit  ৩) export'
    const safe = makeDispatchSafeDetail(reelTask, explanation)
    expect(safe).toBe(explanation)
    expect(buildStaffFriendlyDetail({ ...reelTask, detail: safe })).toBe(explanation)
  })

  it('caps an overlong explanation to 4 lines', () => {
    const explanation = 'ERP খুলুন।\nলাইন ২\nলাইন ৩\nলাইন ৪\nলাইন ৫\nলাইন ৬'
    const safe = makeDispatchSafeDetail(task, explanation)
    expect(safe.split('\n').filter(Boolean).length).toBeLessThanOrEqual(4)
  })

  it('returns empty for a blank explanation so the caller can fall back to the template', () => {
    expect(makeDispatchSafeDetail(task, '   \n  \n')).toBe('')
  })
})
