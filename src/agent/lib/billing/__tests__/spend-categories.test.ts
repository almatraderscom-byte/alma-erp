import { describe, expect, it } from 'vitest'
import {
  classifySpend,
  buildSpendBreakdown,
  spendCategoryMeta,
  SPEND_CATEGORY_META,
  type SpendGroupRow,
} from '@/agent/lib/billing/spend-categories'

describe('classifySpend', () => {
  it('splits chat into owner vs background by conversation source', () => {
    expect(classifySpend({ kind: 'chat', provider: 'anthropic', source: 'web' })).toBe('owner_chat')
    expect(classifySpend({ kind: 'chat', provider: 'gemini', source: 'telegram' })).toBe('owner_chat')
    expect(classifySpend({ kind: 'chat', provider: 'gemini', source: 'ios' })).toBe('owner_chat')
    expect(classifySpend({ kind: 'chat', provider: 'gemini', source: 'day_shift' })).toBe('background_agent')
    expect(classifySpend({ kind: 'chat', provider: 'gemini', source: 'rotation' })).toBe('background_agent')
    expect(classifySpend({ kind: 'chat', provider: 'gemini', source: null })).toBe('background_agent')
  })

  it('splits call into live voice (gemini) vs phone (twilio)', () => {
    expect(classifySpend({ kind: 'call', provider: 'gemini' })).toBe('live_voice')
    expect(classifySpend({ kind: 'call', provider: 'twilio' })).toBe('phone_call')
  })

  it('maps the media/voice/service kinds', () => {
    expect(classifySpend({ kind: 'tts', provider: 'google_tts' })).toBe('voice_message')
    expect(classifySpend({ kind: 'transcribe', provider: 'openai' })).toBe('voice_input')
    expect(classifySpend({ kind: 'image', provider: 'gemini' })).toBe('image')
    expect(classifySpend({ kind: 'video', provider: 'veo' })).toBe('video')
    expect(classifySpend({ kind: 'cs_chat', provider: 'openrouter' })).toBe('customer_service')
    expect(classifySpend({ kind: 'cs_vision', provider: 'gemini' })).toBe('customer_service')
    expect(classifySpend({ kind: 'cs_comment_classify', provider: 'gemini' })).toBe('customer_service')
    expect(classifySpend({ kind: 'qc_vision', provider: 'gemini' })).toBe('quality_check')
    expect(classifySpend({ kind: 'web_research', provider: 'oxylabs' })).toBe('research')
    expect(classifySpend({ kind: 'embedding', provider: 'openai' })).toBe('memory')
  })

  it('routes any unknown kind to other (reconciliation catch-all)', () => {
    expect(classifySpend({ kind: 'weird_new_kind', provider: 'x' })).toBe('other')
    expect(classifySpend({ kind: '', provider: '' })).toBe('other')
  })

  it('is case-insensitive on kind and provider', () => {
    expect(classifySpend({ kind: 'CALL', provider: 'Gemini' })).toBe('live_voice')
  })
})

describe('spendCategoryMeta', () => {
  it('returns meta for a known id and falls back to other', () => {
    expect(spendCategoryMeta('image').icon).toBe('🖼️')
    // @ts-expect-error deliberately passing an invalid id
    expect(spendCategoryMeta('nope').id).toBe('other')
  })
})

describe('buildSpendBreakdown', () => {
  const rows: SpendGroupRow[] = [
    { kind: 'chat', provider: 'gemini', source: 'web', usd: 4.0, count: 20 },
    { kind: 'chat', provider: 'gemini', source: 'telegram', usd: 1.0, count: 10 },
    { kind: 'chat', provider: 'gemini', source: 'day_shift', usd: 2.0, count: 5 },
    { kind: 'call', provider: 'gemini', source: null, usd: 0.5, count: 2 },
    { kind: 'call', provider: 'twilio', source: null, usd: 1.5, count: 3 },
    { kind: 'image', provider: 'gemini', source: null, usd: 0.9, count: 6 },
    { kind: 'tts', provider: 'google_tts', source: null, usd: 0.1, count: 40 },
  ]

  it('totals, orders desc, and reconciles', () => {
    const b = buildSpendBreakdown(rows)
    expect(b.totalUsd).toBeCloseTo(10.0, 6)
    expect(b.reconciled).toBe(true)
    expect(b.reconciledUsd).toBeCloseTo(10.0, 6)
    // largest category first
    expect(b.categories[0].id).toBe('owner_chat') // 4.0 + 1.0 = 5.0
    expect(b.categories[0].usd).toBeCloseTo(5.0, 6)
    expect(b.categories[0].count).toBe(30)
  })

  it('computes the chat headline as owner-chat only (not background)', () => {
    const b = buildSpendBreakdown(rows)
    expect(b.chatHeadlineUsd).toBeCloseTo(5.0, 6)
    const background = b.categories.find((c) => c.id === 'background_agent')
    expect(background?.usd).toBeCloseTo(2.0, 6)
  })

  it('computes percentage share summing to ~100', () => {
    const b = buildSpendBreakdown(rows)
    const pctSum = b.categories.reduce((s, c) => s + c.pct, 0)
    expect(pctSum).toBeGreaterThan(99)
    expect(pctSum).toBeLessThan(101)
  })

  it('drops empty categories but keeps every dollar (reconciliation)', () => {
    const b = buildSpendBreakdown(rows)
    expect(b.categories.every((c) => c.usd > 0)).toBe(true)
    const sum = b.categories.reduce((s, c) => s + c.usd, 0)
    expect(sum).toBeCloseTo(b.totalUsd, 6)
  })

  it('separates live voice from phone call', () => {
    const b = buildSpendBreakdown(rows)
    expect(b.categories.find((c) => c.id === 'live_voice')?.usd).toBeCloseTo(0.5, 6)
    expect(b.categories.find((c) => c.id === 'phone_call')?.usd).toBeCloseTo(1.5, 6)
  })

  it('handles an empty day', () => {
    const b = buildSpendBreakdown([])
    expect(b.totalUsd).toBe(0)
    expect(b.categories).toHaveLength(0)
    expect(b.chatHeadlineUsd).toBe(0)
    expect(b.reconciled).toBe(true)
  })

  it('sends an unmapped kind to the other bucket without breaking reconciliation', () => {
    const b = buildSpendBreakdown([{ kind: 'mystery', provider: 'x', usd: 3.33, count: 1 }])
    expect(b.categories).toHaveLength(1)
    expect(b.categories[0].id).toBe('other')
    expect(b.reconciled).toBe(true)
  })

  it('exposes exactly one meta entry per category id in display order', () => {
    const ids = SPEND_CATEGORY_META.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('owner_chat') // headline first
  })
})
