/** Phase V3 — overlay planner unit tests (frame-exact, fixture inputs). */
import { describe, it, expect } from 'vitest'
import { buildOverlayPlan, FINISH_FPS, DEFAULT_CTA_BN } from '@/lib/creative-studio/video-finish'

const base = { durationSec: 15, width: 1080, height: 1920 }

describe('buildOverlayPlan', () => {
  it('plans all five templates inside the reel bounds', () => {
    const plan = buildOverlayPlan({
      ...base,
      templates: {
        pricePop: { price: '১২৫০' },
        lowerThird: { code: 'ALM-204', name: 'ম্যাচিং পাঞ্জাবি' },
        logoWatermark: true,
        endCard: { code: 'ALM-204', price: '১২৫০' },
        countdown: { days: 3 },
      },
    })
    expect(plan.fps).toBe(FINISH_FPS)
    expect(plan.durationInFrames).toBe(15 * FINISH_FPS)
    expect(plan.needsLogo).toBe(true)
    expect(plan.items.map((i) => i.kind).sort()).toEqual(
      ['countdown', 'end_card', 'logo_watermark', 'lower_third', 'price_pop'],
    )
    for (const item of plan.items) {
      expect(item.from).toBeGreaterThanOrEqual(0)
      expect(item.from + item.durationInFrames).toBeLessThanOrEqual(plan.durationInFrames)
    }
  })

  it('gives the end card the last 2.5s and stops other items there', () => {
    const plan = buildOverlayPlan({
      ...base,
      templates: { pricePop: { price: '999' }, endCard: {} },
    })
    const end = plan.items.find((i) => i.kind === 'end_card')!
    const price = plan.items.find((i) => i.kind === 'price_pop')!
    expect(end.durationInFrames).toBe(Math.round(2.5 * FINISH_FPS))
    expect(end.from + end.durationInFrames).toBe(plan.durationInFrames)
    expect(price.from + price.durationInFrames).toBeLessThanOrEqual(end.from)
    expect(end.props.cta).toBe(DEFAULT_CTA_BN)
  })

  it('shrinks the end card on a very short reel', () => {
    const plan = buildOverlayPlan({ ...base, durationSec: 6, templates: { endCard: {} } })
    const end = plan.items[0]
    expect(end.durationInFrames).toBe(Math.round(6 * FINISH_FPS * 0.25))
  })

  it('is deterministic and rejects empty template sets', () => {
    const input = { ...base, templates: { logoWatermark: true } }
    expect(buildOverlayPlan(input)).toEqual(buildOverlayPlan(input))
    expect(() => buildOverlayPlan({ ...base, templates: {} })).toThrow('no_templates_selected')
    expect(() => buildOverlayPlan({ ...base, durationSec: 1, templates: { logoWatermark: true } }))
      .toThrow('invalid_duration')
  })

  it('ignores blank code/price and clamps long text', () => {
    expect(() =>
      buildOverlayPlan({ ...base, templates: { pricePop: { price: '   ' }, lowerThird: { code: '' } } }),
    ).toThrow('no_templates_selected')
    const plan = buildOverlayPlan({
      ...base,
      templates: { lowerThird: { code: 'X'.repeat(50), name: 'y'.repeat(80) } },
    })
    const lt = plan.items[0]
    expect(String(lt.props.code)).toHaveLength(24)
    expect(String(lt.props.name)).toHaveLength(40)
  })
})
