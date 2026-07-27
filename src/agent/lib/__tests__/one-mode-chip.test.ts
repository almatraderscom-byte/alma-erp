/**
 * ONE mode chip — the bug I made, pinned so it cannot come back.
 *
 * Two mode systems shipped two days apart and both stayed live: `chat-mode.ts`
 * (auto / সরাসরি / প্ল্যান / প্ল্যান-ড্রাইভ) and `permission-mode.ts` (প্ল্যান /
 * সতর্ক / স্বাভাবিক / তত্ত্বাবধান / জরুরি অনুমতি). Both chips sat in the composer,
 * both had a rung called প্ল্যান, and the two প্ল্যানs meant different things —
 * one still allowed `make_plan`, the other took every effect tool away. Their
 * filters ran back to back, so twenty combinations existed and most were
 * designed by nobody; "সরাসরি + প্ল্যান" is a contradiction the code answered by
 * accident.
 *
 * The owner asked for one chip, Claude Code style. These tests hold that:
 * execution style is DERIVED from the permission mode, and the derivation can
 * never produce the two retired values a chip used to set.
 */
import { describe, it, expect } from 'vitest'
import { chatModeForPermission, filterToolsForMode, type ChatMode } from '@/agent/lib/chat-mode'
import { PERMISSION_MODES, type PermissionMode } from '@/agent/lib/permission-mode'

const isRead = (name: string) => name.startsWith('get_') || name.startsWith('list_')

describe('one chip: the execution style follows the permission', () => {
  it('covers every rung of the ladder', () => {
    for (const mode of PERMISSION_MODES) {
      expect(['auto', 'plan']).toContain(chatModeForPermission(mode))
    }
  })

  it('only প্ল্যান restricts execution — the rest differ in what needs a card', () => {
    expect(chatModeForPermission('plan')).toBe('plan')
    for (const mode of ['careful', 'standard', 'supervised', 'elevated'] as PermissionMode[]) {
      expect(chatModeForPermission(mode)).toBe('auto')
    }
  })

  it('never derives the two values the retired chip used to set', () => {
    const derived = PERMISSION_MODES.map(chatModeForPermission)
    expect(derived).not.toContain('direct' as ChatMode)
    expect(derived).not.toContain('plan_drive' as ChatMode)
  })
})

describe('the promise প্ল্যান makes is still kept by tools, not by wording', () => {
  const tools = [
    { name: 'get_orders' },
    { name: 'send_customer_message' },
    { name: 'make_plan' },
    { name: 'execute_plan' },
  ]

  it('প্ল্যান keeps reads and planning, drops the tool that changes the world', () => {
    const kept = filterToolsForMode(chatModeForPermission('plan'), tools, isRead).map((t) => t.name)
    expect(kept).toContain('get_orders')
    expect(kept).toContain('make_plan')
    expect(kept).not.toContain('send_customer_message')
  })

  it('স্বাভাবিক withholds nothing on this axis — cards are the permission ladder’s job', () => {
    const kept = filterToolsForMode(chatModeForPermission('standard'), tools, isRead).map((t) => t.name)
    expect(kept).toEqual(tools.map((t) => t.name))
  })
})
