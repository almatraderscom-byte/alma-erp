import { describe, it, expect } from 'vitest'
import {
  assessFatigue,
  buildCreativeMatrix,
  checkCreativeCompliance,
} from '@/agent/lib/marketing/creative-strategy'

describe('checkCreativeCompliance — hard gates', () => {
  it('clean grounded copy passes', () => {
    const r = checkCreativeCompliance(
      'বাবা-ছেলের ম্যাচিং পাঞ্জাবি সেট — ৳1990। আরামদায়ক কটন, ঈদের জন্য।',
      { name: 'Panjabi set', priceBdt: 1990, facts: ['cotton fabric', 'sizes 2-12y'] },
    )
    expect(r.ok).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('haram references are blocked (Bangla + English)', () => {
    expect(checkCreativeCompliance('celebrate with wine and our panjabi').ok).toBe(false)
    expect(checkCreativeCompliance('জুয়া জিতলে পাঞ্জাবি ফ্রি').ok).toBe(false)
  })

  it('fake urgency/scarcity without basis is blocked', () => {
    const r = checkCreativeCompliance('শুধু আজই শেষ! আর মাত্র ৩ পিস বাকি!')
    expect(r.ok).toBe(false)
    expect(r.violations.some((v) => v.rule.startsWith('urgency:'))).toBe(true)
  })

  it('anonymous fabricated testimonial is blocked', () => {
    const r = checkCreativeCompliance('"অসাধারণ কোয়ালিটি, বারবার কিনবো" — একজন সন্তুষ্ট কাস্টমার')
    expect(r.ok).toBe(false)
    expect(r.violations.some((v) => v.rule.startsWith('testimonial:'))).toBe(true)
  })

  it('guaranteed-outcome and unverifiable superlative claims are blocked', () => {
    expect(checkCreativeCompliance('100% guarantee — double your income!').ok).toBe(false)
    expect(checkCreativeCompliance('বাংলাদেশের সেরা পাঞ্জাবি ব্র্যান্ড').ok).toBe(false)
  })

  it('price not present in product facts → ungrounded (warn), percent claim → block', () => {
    const facts = { name: 'Panjabi', priceBdt: 1990, facts: ['cotton'] }
    const priceLie = checkCreativeCompliance('এখন মাত্র ৳999!', facts)
    expect(priceLie.violations.some((v) => v.rule === 'claim:ungrounded_price' && v.severity === 'warn')).toBe(true)
    const pctLie = checkCreativeCompliance('50% ছাড়!', facts)
    expect(pctLie.ok).toBe(false)
    expect(pctLie.violations.some((v) => v.rule === 'claim:ungrounded_percent')).toBe(true)
    // Grounded percent passes
    const grounded = checkCreativeCompliance('50% ছাড়!', { name: 'P', facts: ['Eid offer: 50% off selected sets'] })
    expect(grounded.ok).toBe(true)
  })
})

describe('buildCreativeMatrix', () => {
  const h = { angle: 'family bonding', hook: 'বাবা-ছেলের ম্যাচিং সেট', offer: 'সেট ৳1990', proof: 'consented customer photos', destination: 'messenger' }

  it('one gated variant per format, all tied to the experiment', () => {
    const variants = buildCreativeMatrix({
      experimentId: 'exp-1',
      hypothesis: h,
      formats: ['static', 'reel', 'sms'],
      productFacts: { name: 'set', priceBdt: 1990, facts: [] },
    })
    expect(variants).toHaveLength(3)
    expect(new Set(variants.map((v) => v.experimentId))).toEqual(new Set(['exp-1']))
    expect(variants.map((v) => v.format)).toEqual(['static', 'reel', 'sms'])
    expect(variants.every((v) => v.compliance.ok)).toBe(true)
  })

  it('a violating hypothesis produces compliance.ok=false variants (fix before preview)', () => {
    const variants = buildCreativeMatrix({
      experimentId: 'exp-2',
      hypothesis: { ...h, hook: '১০০% নিশ্চিত রেজাল্ট!' },
      formats: ['static'],
    })
    expect(variants[0].compliance.ok).toBe(false)
  })
})

describe('assessFatigue — monotonic, creative-level', () => {
  it('fresh creative scores low', () => {
    const f = assessFatigue({ ageDays: 3, frequency: 1.2, ctrTrendRatio: 1 })
    expect(f.level).toBe('fresh')
    expect(f.score).toBeLessThan(30)
  })

  it('high frequency + old + collapsing CTR → fatigued with rotation advice', () => {
    const f = assessFatigue({ ageDays: 30, frequency: 5, ctrTrendRatio: 0.4 })
    expect(f.level).toBe('fatigued')
    expect(f.advice).toContain('Rotate')
  })

  it('each factor increases the score monotonically', () => {
    const base = assessFatigue({ ageDays: 10, frequency: 2, ctrTrendRatio: 0.9 }).score
    expect(assessFatigue({ ageDays: 20, frequency: 2, ctrTrendRatio: 0.9 }).score).toBeGreaterThan(base)
    expect(assessFatigue({ ageDays: 10, frequency: 3, ctrTrendRatio: 0.9 }).score).toBeGreaterThan(base)
    expect(assessFatigue({ ageDays: 10, frequency: 2, ctrTrendRatio: 0.6 }).score).toBeGreaterThan(base)
  })
})
