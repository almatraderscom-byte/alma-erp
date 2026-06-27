import { describe, it, expect } from 'vitest'
import { decideTailFold, estimateMessagesTokens, TAIL_COMPACT_DEFAULTS } from '@/agent/lib/tail-compact'
import { buildSystemPromptBlocks } from '@/agent/lib/system-prompt'

const cfg = TAIL_COMPACT_DEFAULTS
// Derive message counts from the live defaults so these stay correct across tuning.
const keepMsgs = cfg.keepTurns * 2
const overTriggerMsgs = (cfg.triggerTurns + 5) * 2 // comfortably past the turn trigger

describe('decideTailFold', () => {
  it('does not fold a short conversation under both triggers', () => {
    const { shouldFold } = decideTailFold({ total: keepMsgs, compactedCount: 0, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(false)
  })

  it('folds once the turn-count trigger trips, leaving keepTurns verbatim', () => {
    const { shouldFold, foldUpTo } = decideTailFold({ total: overTriggerMsgs, compactedCount: 0, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(true)
    expect(foldUpTo).toBe(overTriggerMsgs - keepMsgs)
  })

  it('folds on the token trigger even when turn count is low', () => {
    const { shouldFold } = decideTailFold({ total: keepMsgs + 2, compactedCount: 0, unfoldedTokens: cfg.triggerTokens + 10_000, cfg })
    expect(shouldFold).toBe(true)
  })

  it('respects hysteresis: does not re-fold when only the keep window remains unfolded', () => {
    // Already folded up to (total - keepMsgs); exactly keepMsgs remain, nothing older to fold.
    const { shouldFold } = decideTailFold({ total: overTriggerMsgs, compactedCount: overTriggerMsgs - keepMsgs, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(false)
  })

  it('never returns a watermark behind the current one', () => {
    const watermark = overTriggerMsgs - keepMsgs
    const { foldUpTo } = decideTailFold({ total: watermark + 5, compactedCount: watermark, unfoldedTokens: 1000, cfg })
    expect(foldUpTo).toBeGreaterThanOrEqual(watermark)
  })
})

describe('estimateMessagesTokens', () => {
  it('sums text across string and block content', () => {
    const rows = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(40) }] },
    ]
    // ~ chars/4 each → ~20 total
    expect(estimateMessagesTokens(rows)).toBeGreaterThan(10)
  })
})

describe('tailSummary placement', () => {
  it('rides the STABLE (cached) block, never the volatile tail — business mode', () => {
    const summary = '- পুরোনো অর্ডার নিয়ে আলোচনা\n- দাম ঠিক হয়েছে ১২০০ টাকা'
    const { stable, volatile } = buildSystemPromptBlocks({ personalMode: false, tailSummary: summary })
    const stableText = stable.map((b) => b.text).join('\n')
    const volatileText = volatile.map((b) => b.text).join('\n')
    expect(stableText).toContain(summary)
    expect(volatileText).not.toContain(summary)
    // stable block must carry the cache_control marker so the summary is cached.
    expect(stable[0]).toHaveProperty('cache_control')
  })

  it('rides the STABLE block in personal mode too', () => {
    const summary = '- ব্যক্তিগত খরচের হিসাব'
    const { stable, volatile } = buildSystemPromptBlocks({ personalMode: true, tailSummary: summary })
    expect(stable.map((b) => b.text).join('\n')).toContain(summary)
    expect(volatile.map((b) => b.text).join('\n')).not.toContain(summary)
  })

  it('injects nothing when no summary is present (no prefix change)', () => {
    const { stable } = buildSystemPromptBlocks({ personalMode: false })
    expect(stable.map((b) => b.text).join('\n')).not.toContain('চলমান সারাংশ')
  })
})
