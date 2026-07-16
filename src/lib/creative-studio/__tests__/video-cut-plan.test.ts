/**
 * Phase V1 — cut-planner unit tests with fixture timestamps.
 *
 * The planner is the deterministic heart of the video Recipe Engine: the VPS
 * worker feeds it ffmpeg scdet timestamps and executes whatever it returns, so
 * these tests are the contract for what lands on the owner's reels.
 */
import { describe, it, expect } from 'vitest'
import {
  planCuts,
  getVideoRecipe,
  VIDEO_RECIPES,
  type CutPlan,
  type VideoRecipe,
} from '@/lib/creative-studio/video-recipes'

const recipe = (id: string): VideoRecipe => {
  const r = getVideoRecipe(id)
  if (!r) throw new Error(`missing recipe ${id}`)
  return r
}

/** typical 2-min phone shoot: a scene change every ~8s with human jitter */
const TWO_MIN_SCENES = [
  7.8, 16.2, 23.9, 32.4, 40.1, 48.7, 55.9, 64.3, 71.8, 80.2, 88.6, 95.4, 104.1, 111.7,
]

function assertWellFormed(plan: CutPlan, durationSec: number) {
  expect(plan.segments.length).toBeGreaterThan(0)
  let prevEnd = -1
  for (const seg of plan.segments) {
    expect(seg.start).toBeGreaterThanOrEqual(0)
    expect(seg.end).toBeLessThanOrEqual(durationSec + 0.01)
    expect(seg.end - seg.start).toBeGreaterThan(0.5)
    // chronological and non-overlapping — clips never jump backwards
    expect(seg.start).toBeGreaterThanOrEqual(prevEnd)
    prevEnd = seg.end
  }
}

describe('planCuts — product_showcase (hard cuts)', () => {
  it('fills a 30s target from a 120s shoot with ~3s clips', () => {
    const plan = planCuts({
      recipe: recipe('product_showcase'),
      durationSec: 120,
      sceneChanges: TWO_MIN_SCENES,
      targetSec: 30,
    })
    assertWellFormed(plan, 120)
    expect(plan.transition).toBe('cut')
    expect(plan.fadeSec).toBe(0)
    expect(plan.totalSec).toBeGreaterThanOrEqual(29)
    expect(plan.totalSec).toBeLessThanOrEqual(31)
    // ~3s clips → about 10 of them
    expect(plan.segments.length).toBeGreaterThanOrEqual(9)
    expect(plan.segments.length).toBeLessThanOrEqual(11)
    for (const seg of plan.segments) {
      expect(seg.end - seg.start).toBeLessThanOrEqual(3.01)
    }
  })

  it('spreads clips across the whole video, not just the beginning', () => {
    const plan = planCuts({
      recipe: recipe('product_showcase'),
      durationSec: 120,
      sceneChanges: TWO_MIN_SCENES,
      targetSec: 15,
    })
    const first = plan.segments[0]
    const last = plan.segments[plan.segments.length - 1]
    expect(first.start).toBeLessThan(20)
    expect(last.end).toBeGreaterThan(90)
  })
})

describe('planCuts — family_shoot (crossfade)', () => {
  it('accounts for crossfade overlap when hitting the target', () => {
    const plan = planCuts({
      recipe: recipe('family_shoot'),
      durationSec: 120,
      sceneChanges: TWO_MIN_SCENES,
      targetSec: 30,
    })
    assertWellFormed(plan, 120)
    expect(plan.transition).toBe('crossfade')
    expect(plan.fadeSec).toBe(0.5)
    // totalSec is the POST-overlap length: sum(clips) - (n-1)*fade
    const raw = plan.segments.reduce((s, seg) => s + (seg.end - seg.start), 0)
    const expected = raw - (plan.segments.length - 1) * plan.fadeSec
    expect(Math.abs(plan.totalSec - expected)).toBeLessThan(0.02)
    expect(plan.totalSec).toBeGreaterThanOrEqual(29)
    expect(plan.totalSec).toBeLessThanOrEqual(31)
  })

  it('skips the shaky first moments of each scene', () => {
    const plan = planCuts({
      recipe: recipe('family_shoot'),
      durationSec: 120,
      sceneChanges: TWO_MIN_SCENES,
      targetSec: 15,
    })
    // every scene here is ≥7s long, so each clip starts skipInSec after its cut
    const starts = plan.segments.map((s) => s.start)
    const boundaries = [0, ...TWO_MIN_SCENES]
    for (const start of starts) {
      const nearest = boundaries.reduce((best, b) => (Math.abs(b - start) < Math.abs(best - start) ? b : best))
      expect(start).toBeGreaterThanOrEqual(nearest)
    }
  })
})

describe('planCuts — fallbacks and edges', () => {
  it('uses the whole video when it is shorter than the target', () => {
    const plan = planCuts({
      recipe: recipe('product_showcase'),
      durationSec: 12,
      sceneChanges: [4, 8],
      targetSec: 15,
    })
    expect(plan.segments).toEqual([{ start: 0, end: 12 }])
    expect(plan.totalSec).toBe(12)
  })

  it('handles a static shot (no scene changes) with evenly-spaced windows', () => {
    const plan = planCuts({
      recipe: recipe('product_showcase'),
      durationSec: 90,
      sceneChanges: [],
      targetSec: 30,
    })
    assertWellFormed(plan, 90)
    expect(plan.totalSec).toBeGreaterThanOrEqual(29)
    expect(plan.totalSec).toBeLessThanOrEqual(31)
    // windows must span the timeline
    expect(plan.segments[plan.segments.length - 1].end).toBeGreaterThan(60)
  })

  it('ignores scenes shorter than the recipe minimum', () => {
    // rapid-fire cuts at the start (0.3s apart) then two long takes
    const plan = planCuts({
      recipe: recipe('family_shoot'), // minSceneSec 2.5
      durationSec: 60,
      sceneChanges: [1, 1.3, 1.6, 1.9, 30],
      targetSec: 15,
    })
    assertWellFormed(plan, 60)
    // no clip should sit inside the 1–2s junk region
    for (const seg of plan.segments) {
      const inJunk = seg.start >= 1 && seg.end <= 2
      expect(inJunk).toBe(false)
    }
  })

  it('is deterministic — identical input yields the identical plan', () => {
    const input = {
      recipe: recipe('offer_promo'),
      durationSec: 95.37,
      sceneChanges: TWO_MIN_SCENES.slice(0, 10),
      targetSec: 15,
    }
    expect(planCuts(input)).toEqual(planCuts(input))
  })

  it('offer_promo cuts fast — every clip at most 2s', () => {
    const plan = planCuts({
      recipe: recipe('offer_promo'),
      durationSec: 90,
      sceneChanges: TWO_MIN_SCENES.slice(0, 11),
      targetSec: 15,
    })
    assertWellFormed(plan, 90)
    for (const seg of plan.segments) {
      expect(seg.end - seg.start).toBeLessThanOrEqual(2.01)
    }
    expect(plan.totalSec).toBeGreaterThanOrEqual(14)
    expect(plan.totalSec).toBeLessThanOrEqual(16)
  })

  it('rejects a broken duration', () => {
    expect(() =>
      planCuts({ recipe: recipe('product_showcase'), durationSec: 0, sceneChanges: [], targetSec: 15 }),
    ).toThrow('invalid_duration')
  })

  it('every recipe can plan every one of its advertised targets from a 2-min shoot', () => {
    for (const r of VIDEO_RECIPES) {
      for (const target of r.targets) {
        const plan = planCuts({ recipe: r, durationSec: 120, sceneChanges: TWO_MIN_SCENES, targetSec: target })
        assertWellFormed(plan, 120)
        expect(Math.abs(plan.totalSec - target)).toBeLessThanOrEqual(1.5)
      }
    }
  })
})

// ── CS11: video hardening pure spec ──────────────────────────────────────────
import {
  CAPTION_SAFE_AREA,
  LOUDNESS_TARGET,
  LOUDNORM_FILTER,
  VIDEO_ERRORS_BN,
  clampCaptionMarginV,
  looksLikeRawInternalError,
  sanitizeVideoErrorMessage,
  scoreCoverOrder,
} from '../video-recipes'

describe('CS11 — loudness target locked', () => {
  it('-14 LUFS integrated, -1 dBTP, filter string matches', () => {
    expect(LOUDNESS_TARGET.integratedLufs).toBe(-14)
    expect(LOUDNESS_TARGET.truePeakDb).toBe(-1)
    expect(LOUDNORM_FILTER).toBe('loudnorm=I=-14:TP=-1:LRA=11')
  })
})

describe('CS11 — error sanitization (owner never sees raw internals)', () => {
  it('maps raw failures to Bangla codes', () => {
    expect(sanitizeVideoErrorMessage('Veo video generation timed out after 12 minutes')).toBe(VIDEO_ERRORS_BN.VEO_TIMEOUT)
    expect(sanitizeVideoErrorMessage('Veo download failed: fetch failed')).toBe(VIDEO_ERRORS_BN.VEO_DOWNLOAD)
    expect(sanitizeVideoErrorMessage('ffmpeg exited with code 1: /tmp/reel-x.mp4 ...')).toBe(VIDEO_ERRORS_BN.FFMPEG_RENDER)
    expect(sanitizeVideoErrorMessage('QC_BLACK: 42% black frames')).toBe(VIDEO_ERRORS_BN.QC_BLACK)
    expect(sanitizeVideoErrorMessage('')).toBe(VIDEO_ERRORS_BN.UNKNOWN)
    // every mapped message is Bangla-facing and carries its code
    for (const [code, msg] of Object.entries(VIDEO_ERRORS_BN)) expect(msg).toContain(code)
  })

  it('detects raw internals in legacy stored errors', () => {
    expect(looksLikeRawInternalError('ffmpeg exited with code 1')).toBe(true)
    expect(looksLikeRawInternalError('spawn ffprobe ENOENT')).toBe(true)
    expect(looksLikeRawInternalError('ভিডিও প্রসেসিং ব্যর্থ (কোড: FFMPEG_RENDER)')).toBe(false)
    expect(looksLikeRawInternalError(null)).toBe(false)
  })
})

describe('CS11 — cover ordering + caption safe area', () => {
  it('sharp, well-exposed frames rank first; dark frames penalized', () => {
    const order = scoreCoverOrder([
      { index: 0, sharpness: 10, brightness: 20 }, // dark → penalty
      { index: 1, sharpness: 100, brightness: 120 }, // best
      { index: 2, sharpness: 60, brightness: 130 },
    ])
    expect(order[0]).toBe(1)
    expect(order[1]).toBe(2)
    expect(order[2]).toBe(0)
  })

  it('caption margin clamps into the safe band', () => {
    expect(clampCaptionMarginV(10, 1920)).toBe(CAPTION_SAFE_AREA.minMarginVPx)
    expect(clampCaptionMarginV(2000, 1920)).toBe(Math.round(1920 * CAPTION_SAFE_AREA.maxBottomFraction))
    expect(clampCaptionMarginV(200, 1920)).toBe(200)
  })
})
