import { describe, it, expect } from 'vitest'
import { decideTailFold, estimateMessagesTokens, TAIL_COMPACT_DEFAULTS } from '@/agent/lib/tail-compact'
import { buildSystemPromptBlocks } from '@/agent/lib/system-prompt'

const cfg = TAIL_COMPACT_DEFAULTS // triggerTurns 30, triggerTokens 80k, keepTurns 20

describe('decideTailFold', () => {
  it('does not fold a short conversation under both triggers', () => {
    const { shouldFold } = decideTailFold({ total: 20, compactedCount: 0, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(false)
  })

  it('folds once the turn-count trigger trips, leaving keepTurns verbatim', () => {
    // 70 messages = 35 turns > triggerTurns(30). keepMsgs = 40 → foldUpTo = 30.
    const { shouldFold, foldUpTo } = decideTailFold({ total: 70, compactedCount: 0, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(true)
    expect(foldUpTo).toBe(70 - cfg.keepTurns * 2)
  })

  it('folds on the token trigger even when turn count is low', () => {
    const { shouldFold } = decideTailFold({ total: 50, compactedCount: 0, unfoldedTokens: 90_000, cfg })
    expect(shouldFold).toBe(true)
  })

  it('respects hysteresis: does not re-fold when only the keep window remains unfolded', () => {
    // Already folded up to 30; 40 messages remain (= keepMsgs), nothing older to fold.
    const { shouldFold } = decideTailFold({ total: 70, compactedCount: 30, unfoldedTokens: 1000, cfg })
    expect(shouldFold).toBe(false)
  })

  it('never returns a watermark behind the current one', () => {
    const { foldUpTo } = decideTailFold({ total: 35, compactedCount: 30, unfoldedTokens: 1000, cfg })
    expect(foldUpTo).toBeGreaterThanOrEqual(30)
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
