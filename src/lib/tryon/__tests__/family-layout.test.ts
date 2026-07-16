import { describe, expect, it } from 'vitest'
import {
  EXPECTED_MEMBER_COUNT,
  INSERT_GAP_RATIO,
  INSERT_RELATIVE_HEIGHT,
  buildHarmonizeMaskSpec,
  planInsertPlacement,
} from '../family-layout'

const CANVAS = { canvasWidth: 1600, canvasHeight: 2000 }
// base adult roughly centered-left: x 300, width 500, y 200, height 1600
const BASE = { x: 300, y: 200, width: 500, height: 1600 }

describe('relative heights (owner-locked anthropometry)', () => {
  it('child/adult ratios are correct and bounded', () => {
    expect(INSERT_RELATIVE_HEIGHT.son).toBe(0.62)
    expect(INSERT_RELATIVE_HEIGHT.daughter).toBe(0.56)
    expect(INSERT_RELATIVE_HEIGHT.mother).toBe(0.94)
    expect(INSERT_RELATIVE_HEIGHT.pair).toBe(1.0)
    for (const v of Object.values(INSERT_RELATIVE_HEIGHT)) {
      expect(v).toBeGreaterThan(0.4)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('planInsertPlacement', () => {
  it('scales a son to 0.62 of the adult and shares the ground line', () => {
    const p = planInsertPlacement({ ...CANVAS, baseBBox: BASE, insertAspect: 0.45, role: 'son' })
    expect(p.height).toBe(Math.round(1600 * 0.62)) // 992
    expect(p.width).toBe(Math.round(p.height * 0.45))
    // feet on the base person's baseline
    expect(p.y + p.height).toBe(BASE.y + BASE.height)
    expect(p.cramped).toBe(false)
  })

  it('places on the roomier side with the correct gap', () => {
    const p = planInsertPlacement({ ...CANVAS, baseBBox: BASE, insertAspect: 0.45, role: 'son' })
    expect(p.side).toBe('right') // room right = 800 vs left = 300
    expect(p.x).toBe(BASE.x + BASE.width + Math.round(BASE.height * INSERT_GAP_RATIO))
  })

  it('flips side when the preferred side cannot fit', () => {
    const rightCrampedBase = { x: 900, y: 200, width: 600, height: 1600 } // room right = 100
    const p = planInsertPlacement({
      ...CANVAS,
      baseBBox: rightCrampedBase,
      insertAspect: 0.45,
      role: 'son',
      preferSide: 'right',
    })
    expect(p.side).toBe('left')
    expect(p.x + p.width).toBeLessThanOrEqual(rightCrampedBase.x)
  })

  it('clamps inside the canvas and reports cramped when truly no room', () => {
    const huge = { x: 100, y: 100, width: 1400, height: 1800 }
    const p = planInsertPlacement({ ...CANVAS, baseBBox: huge, insertAspect: 0.5, role: 'mother' })
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x + p.width).toBeLessThanOrEqual(CANVAS.canvasWidth)
    expect(p.cramped).toBe(true)
  })

  it('a pair unit matches the base adult height (1.0)', () => {
    const p = planInsertPlacement({ ...CANVAS, baseBBox: BASE, insertAspect: 0.9, role: 'pair' })
    expect(p.height).toBe(BASE.height)
  })
})

describe('harmonize mask spec — fill may touch ONLY edges + ground', () => {
  it('thin edge band scaled to insert size, ground ellipse under the feet', () => {
    const placement = planInsertPlacement({ ...CANVAS, baseBBox: BASE, insertAspect: 0.45, role: 'son' })
    const spec = buildHarmonizeMaskSpec(placement)
    expect(spec.edgeBandPx).toBeGreaterThanOrEqual(6)
    expect(spec.edgeBandPx).toBeLessThanOrEqual(Math.round(placement.height * 0.02))
    expect(spec.ground.cy).toBe(placement.y + placement.height)
    expect(spec.ground.rx).toBeLessThan(placement.width)
  })
})

describe('member count expectations', () => {
  it('pairs/couple = 2, full family = 4 — the 100% count rule', () => {
    expect(EXPECTED_MEMBER_COUNT.father_son).toBe(2)
    expect(EXPECTED_MEMBER_COUNT.couple).toBe(2)
    expect(EXPECTED_MEMBER_COUNT.full_family).toBe(4)
  })
})
