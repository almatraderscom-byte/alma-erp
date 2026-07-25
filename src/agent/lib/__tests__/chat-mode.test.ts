/**
 * Chat mode. The point of these tests: a mode must be ENFORCED, not requested.
 * If the filter ever degrades to "the prompt asks nicely", direct mode can still
 * park work in the background and plan mode can still change the live business.
 */
import { describe, it, expect } from 'vitest'
import {
  CHAT_MODES,
  CHAT_MODE_META,
  DEFAULT_CHAT_MODE,
  chatModeDirective,
  filterToolsForMode,
  isChatMode,
  normalizeChatMode,
  toolPolicyFor,
} from '@/agent/lib/chat-mode'

const TOOLS = [
  { name: 'get_orders' },
  { name: 'get_sales_summary' },
  { name: 'make_plan' },
  { name: 'execute_plan' },
  { name: 'start_fix_campaign' },
  { name: 'send_whatsapp' },
  { name: 'post_to_facebook' },
  { name: 'ask_user' },
  { name: 'save_memory' },
]
const READS = new Set(['get_orders', 'get_sales_summary'])
const isRead = (n: string) => READS.has(n)
const names = (mode: Parameters<typeof filterToolsForMode>[0]) =>
  filterToolsForMode(mode, TOOLS, isRead).map((t) => t.name)

describe('chat mode', () => {
  it('unknown/absent values fall back to auto — today\'s behaviour', () => {
    expect(normalizeChatMode(undefined)).toBe('auto')
    expect(normalizeChatMode(null)).toBe('auto')
    expect(normalizeChatMode('nonsense')).toBe('auto')
    expect(DEFAULT_CHAT_MODE).toBe('auto')
    expect(isChatMode('plan_drive')).toBe(true)
    expect(isChatMode('bypass')).toBe(false)
  })

  it('every mode has an owner-facing label and hint', () => {
    for (const m of CHAT_MODES) {
      expect(CHAT_MODE_META[m].label.length).toBeGreaterThan(0)
      expect(CHAT_MODE_META[m].hint.length).toBeGreaterThan(0)
      expect(chatModeDirective(m)).toBeTruthy()
    }
  })

  it('auto and plan-drive keep the full tool set', () => {
    expect(toolPolicyFor('auto')).toBe('all')
    expect(names('auto')).toEqual(TOOLS.map((t) => t.name))
    expect(names('plan_drive')).toEqual(TOOLS.map((t) => t.name))
  })

  it('direct mode removes the planning tools, so "I will do it in the background" is impossible', () => {
    const kept = names('direct')
    expect(kept).not.toContain('make_plan')
    expect(kept).not.toContain('execute_plan')
    expect(kept).not.toContain('start_fix_campaign')
    // …but it can still actually DO the work.
    expect(kept).toContain('send_whatsapp')
    expect(kept).toContain('get_orders')
  })

  it('plan mode can research and propose, but cannot change anything', () => {
    const kept = names('plan')
    expect(kept).toContain('get_orders')
    expect(kept).toContain('make_plan')
    expect(kept).toContain('ask_user')
    expect(kept).toContain('save_memory')
    // Nothing that touches the outside world.
    expect(kept).not.toContain('send_whatsapp')
    expect(kept).not.toContain('post_to_facebook')
    expect(kept).not.toContain('execute_plan')
    expect(kept).not.toContain('start_fix_campaign')
  })

  it('there is no bypass-permissions mode', () => {
    expect(CHAT_MODES).not.toContain('bypass' as never)
    expect(CHAT_MODES).toHaveLength(4)
  })
})
