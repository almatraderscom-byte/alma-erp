import { describe, it, expect } from 'vitest'
import {
  answerGateScopeForContext,
  isGateableQuestion,
  GATE_DENY_RE,
  isExpensiveHead,
} from '@/agent/lib/answer-gate'
import { getModel } from '@/agent/lib/models/registry'

/**
 * Answer Gate hard rules (owner decision 2026-07-08). The owner's #1 fear is a
 * confident WRONG answer — so these tests pin the deny side hardest.
 */
describe('answer gate — deny rules (never gated)', () => {
  it('live-data questions never gate', () => {
    expect(isGateableQuestion('aj koto sale holo?')).toBe(false)
    expect(isGateableQuestion('আজ কত বিক্রি হয়েছে?')).toBe(false)
    expect(isGateableQuestion('pending order koto?')).toBe(false)
    expect(isGateableQuestion('কে অফিসে আছে এখন?')).toBe(false)
    expect(isGateableQuestion('stock e koyta ase?')).toBe(false)
    expect(isGateableQuestion('Eyafi staff profile ta ki?')).toBe(false)
    expect(isGateableQuestion('Main Binance trading account ta ki?')).toBe(false)
    expect(isGateableQuestion('Eyafi সম্পর্কে কী জানো?', 'business')).toBe(false)
    expect(isGateableQuestion('Main Binance-এর অবস্থা কী?', 'business')).toBe(false)
  })

  it('money figures never gate', () => {
    expect(isGateableQuestion('ওর বেতন কত টাকা?')).toBe(false)
    expect(GATE_DENY_RE.test('balance koto ase')).toBe(true)
  })

  it('actions/tasks never gate', () => {
    expect(isGateableQuestion('ekta post banao facebook er jonno?')).toBe(false)
    expect(isGateableQuestion('Rakib ke call koro?')).toBe(false)
    expect(isGateableQuestion('order ta delete korbo kivabe?')).toBe(false)
  })

  it('salah never gates', () => {
    expect(isGateableQuestion('মাগরিবের নামাজের সময় কখন?')).toBe(false)
  })

  it('follow-ups/continuations never gate (need conversation context)', () => {
    expect(isGateableQuestion('accha tarpor?')).toBe(false)
    expect(isGateableQuestion('আগেরটা কী ছিল?')).toBe(false)
    expect(isGateableQuestion('ok')).toBe(false)
    expect(isGateableQuestion('??')).toBe(false)
  })

  it('too-short and too-long inputs never gate', () => {
    expect(isGateableQuestion('ki?')).toBe(false)
    expect(isGateableQuestion('x'.repeat(300) + '?')).toBe(false)
  })
})

describe('answer gate — allow side (stable knowledge questions)', () => {
  it('static-fact questions are gateable', () => {
    expect(isGateableQuestion('আমাদের ওয়েবসাইটের ঠিকানা কী?')).toBe(true)
    expect(isGateableQuestion('return policy ta ki আমাদের?')).toBe(true)
    expect(isGateableQuestion('আমাদের কোন কোন business আছে?')).toBe(true)
    expect(isGateableQuestion('আমাদের ওয়েবসাইটের ঠিকানা কী?', 'business')).toBe(false)
  })

  it('business turns always run fresh so entity-adjacent wording cannot replay linkless prose', () => {
    expect(isGateableQuestion('ALMA সম্পর্কে কী জানো?', 'business')).toBe(false)
    expect(isGateableQuestion('return policy ta ki আমাদের?', 'business')).toBe(false)
    expect(isGateableQuestion('Eyafi কোন business-এ কাজ করে?', 'business')).toBe(false)
    expect(isGateableQuestion('Eyafi আমাদের কোন brand-এর লোক?', 'business')).toBe(false)
    expect(isGateableQuestion('Mustahid-এর office address কী?', 'business')).toBe(false)
  })

  it('non-questions are not gateable', () => {
    expect(isGateableQuestion('মনে রাখো আমাদের অফিস শনিবার খোলা')).toBe(false)
  })
})

describe('answer gate — expensive-head scoping', () => {
  it('gates Gemini Pro / Qwen Max / Anthropic, bypasses DeepSeek-class', () => {
    expect(isExpensiveHead(getModel('gemini-3.1-pro'))).toBe(true)
    expect(isExpensiveHead(getModel('or-qwen3-max'))).toBe(true)
    expect(isExpensiveHead(getModel('or-deepseek-v4-flash'))).toBe(false)
    expect(isExpensiveHead(getModel('gemini-3.1-flash-lite'))).toBe(false)
  })

  it('uses distinct cache scopes per business and never serves legacy generic business rows', () => {
    const lifestyle = answerGateScopeForContext(false, 'ALMA_LIFESTYLE')
    const trading = answerGateScopeForContext(false, 'ALMA_TRADING')

    expect(lifestyle).toBe('business:ALMA_LIFESTYLE')
    expect(trading).toBe('business:ALMA_TRADING')
    expect(lifestyle).not.toBe(trading)
    expect([lifestyle, trading]).not.toContain('business')
    expect(answerGateScopeForContext(true, 'ALMA_TRADING')).toBe('personal')
  })
})
