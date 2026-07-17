import { describe, it, expect, vi } from 'vitest'

// Phase 32 guard: record every prisma model applyTailCompaction touches so we
// can assert it NEVER reaches the canonical focus/state tables and NEVER
// deletes anything — folding chat can't destroy "where we are".
const touchedModels = new Set<string>()
const calledOps = new Set<string>()
vi.mock('@/lib/prisma', () => {
  const op = (model: string, name: string, fn: (args?: unknown) => unknown) =>
    new Proxy(fn, { apply: (t, self, args) => { calledOps.add(`${model}.${name}`); return Reflect.apply(t, self, args) } })
  const model = (name: string, impl: Record<string, (args?: unknown) => unknown>) =>
    new Proxy(impl, { get: (t, p: string) => op(name, p, t[p] ?? (async () => { throw new Error(`unmocked ${name}.${p}`) })) })
  const models: Record<string, unknown> = {
    agentKvSetting: model('agentKvSetting', { findMany: async () => [] }),
    agentConversation: model('agentConversation', {
      findUnique: async () => ({ tailSummary: null, tailCompactedCount: 0 }),
      update: async () => ({}),
    }),
    agentMessage: model('agentMessage', { findMany: async () => [{ role: 'user', content: 'hi' }] }),
  }
  return {
    prisma: new Proxy(models, {
      get: (t, p: string) => { touchedModels.add(p); return t[p] ?? model(p, {}) },
    }),
  }
})

import { decideTailFold, estimateMessagesTokens, TAIL_COMPACT_DEFAULTS, applyTailCompaction } from '@/agent/lib/tail-compact'
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

describe('phase 32 — compaction never deletes canonical focus state', () => {
  it('applyTailCompaction touches only conversation/message/kv tables and never deletes', async () => {
    touchedModels.clear()
    calledOps.clear()
    await applyTailCompaction('c-focus-guard')
    const focusTables = [...touchedModels].filter((m) =>
      /focus|workflowRun|pendingAction|askCard|openTask|checkpoint/i.test(m),
    )
    expect(focusTables).toEqual([])
    const deletes = [...calledOps].filter((o) => /delete/i.test(o))
    expect(deletes).toEqual([])
    // Sanity: it did do its own reads.
    expect(touchedModels.has('agentConversation')).toBe(true)
  })
})
