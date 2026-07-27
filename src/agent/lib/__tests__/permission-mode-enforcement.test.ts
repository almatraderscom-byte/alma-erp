/**
 * PM-2 — the mode stops being advice.
 *
 * PM-1 told the head which mode it was in and the head ignored it, live, on the
 * preview: in Plan mode it went straight for the work. That is the lesson this
 * repo keeps relearning — a sentence is a request, an empty tool list is a
 * guarantee.
 */
import { describe, it, expect } from 'vitest'
import {
  filterToolsForPermissionMode,
  modeVerdict,
  adviseForAction,
} from '@/agent/lib/permission-mode'

const TOOLS = [
  { name: 'get_orders' },
  { name: 'audit_product_seo' },
  { name: 'draft_seo_fixes' },
  { name: 'update_product_web' },
  { name: 'send_customer_message' },
  { name: 'log_expense' },
  { name: 'make_plan' },
  { name: 'ask_user' },
  { name: 'save_memory' },
  { name: 'find_tool' },
]
const READS = new Set(['get_orders', 'audit_product_seo'])
const isRead = (n: string) => READS.has(n)

describe('Plan mode withholds every way to change anything', () => {
  const { tools, removed } = filterToolsForPermissionMode('plan', TOOLS, isRead)
  const kept = tools.map((t) => t.name)

  it('keeps reading, planning, asking and remembering', () => {
    expect(kept).toEqual(expect.arrayContaining([
      'get_orders', 'audit_product_seo', 'make_plan', 'ask_user', 'save_memory', 'find_tool',
    ]))
  })

  it('removes everything that touches the world', () => {
    for (const gone of ['draft_seo_fixes', 'update_product_web', 'send_customer_message', 'log_expense']) {
      expect(kept).not.toContain(gone)
      expect(removed).toContain(gone)
    }
  })

  it('does not even leave the card-staging tools — a card is a request to change', () => {
    expect(kept).not.toContain('draft_seo_fixes')
  })
})

describe('the other modes do not withhold', () => {
  for (const mode of ['careful', 'standard', 'supervised', 'elevated'] as const) {
    it(`${mode} keeps the full list`, () => {
      const { tools, removed } = filterToolsForPermissionMode(mode, TOOLS, isRead)
      expect(tools).toHaveLength(TOOLS.length)
      expect(removed).toEqual([])
    })
  }

  it('careful must keep them — you cannot stage a card for a tool never offered', () => {
    const { tools } = filterToolsForPermissionMode('careful', TOOLS, isRead)
    expect(tools.map((t) => t.name)).toContain('log_expense')
    // …and the verdict is what turns that call into a card.
    expect(modeVerdict({ mode: 'careful', tier: 'R2' })).toBe('card')
  })
})

describe('a refusal carries its own remedy', () => {
  it('names the mode, the reason and the way out', () => {
    const advice = adviseForAction({
      mode: 'plan',
      tier: 'R1',
      whatBn: '`draft_seo_fixes` দিয়ে যা করতে চাইছ',
    })
    expect(advice.verdict).toBe('blocked')
    expect(advice.blockedByMode).toBe(true)
    expect(advice.suggestedMode).toBe('careful')
    expect(advice.reasonBn).toContain('প্ল্যান')
    expect(advice.reasonBn).toContain('draft_seo_fixes')
    expect(advice.reasonBn).toContain('মোডটা বদলে দেবেন?')
  })

  it('and it is never a bare "cannot"', () => {
    const advice = adviseForAction({ mode: 'plan', tier: 'R2', whatBn: 'খরচ লেখা' })
    expect(advice.reasonBn.length).toBeGreaterThan(40)
    expect(advice.suggestedMode).not.toBeNull()
  })
})
