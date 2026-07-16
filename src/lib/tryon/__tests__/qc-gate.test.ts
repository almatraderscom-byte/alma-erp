import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_MIN_CORE_AXIS,
  buildQcFlagMessage,
  evaluateProductionCoreAxes,
  evaluateQCScore,
  getQcConfig,
  pickWeakestAxis,
  type QCScore,
} from '../qc-gate'

function score(overrides: Partial<QCScore> = {}): QCScore {
  return {
    garment_fidelity: 4,
    model_preserved: 4,
    anatomy: 4,
    brand_consistency: 4,
    text_legibility: 5,
    composition: 4,
    overall: 4,
    fail_reasons: [],
    fix_hint: '',
    ...overrides,
  }
}

describe('qc level configs', () => {
  it('off bypasses, normal floors axes at 2, strict at 3', () => {
    expect(getQcConfig('off').maxRegen).toBe(0)
    expect(getQcConfig('normal').minAxis).toBe(2)
    expect(getQcConfig('strict').minAxis).toBe(3)
  })

  it('evaluateQCScore honours level floors', () => {
    expect(evaluateQCScore(score(), 'normal')).toBe(true)
    expect(evaluateQCScore(score({ anatomy: 2 }), 'strict')).toBe(false)
    expect(evaluateQCScore(score({ anatomy: 1 }), 'off')).toBe(true)
  })
})

describe('CS8/CS10 production core-axis gate', () => {
  it('floor is 4 and every core axis is checked', () => {
    expect(PRODUCTION_MIN_CORE_AXIS).toBe(4)
    expect(evaluateProductionCoreAxes(score())).toBe(true)
    expect(evaluateProductionCoreAxes(score({ garment_fidelity: 3 }))).toBe(false)
    expect(evaluateProductionCoreAxes(score({ model_preserved: 3 }))).toBe(false)
    expect(evaluateProductionCoreAxes(score({ anatomy: 3 }))).toBe(false)
    // the audit case: strong overall must NOT rescue a weak core axis
    expect(evaluateProductionCoreAxes(score({ overall: 5, anatomy: 2 }))).toBe(false)
  })
})

describe('weakest axis + flag message', () => {
  it('picks the lowest axis and words the flag honestly', () => {
    const s = score({ anatomy: 2, overall: 3 })
    expect(pickWeakestAxis(s)).toBe('anatomy')
    expect(buildQcFlagMessage(3, s, false)).toContain('best of 3')
    expect(buildQcFlagMessage(2, s, true)).toContain('passed on attempt 2')
    expect(buildQcFlagMessage(1, s, true)).toBeUndefined()
  })
})
