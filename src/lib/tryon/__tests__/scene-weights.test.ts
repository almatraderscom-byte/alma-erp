/** CS4 — deterministic scene weighting (pure, injected rand). */
import { describe, it, expect } from 'vitest'
import { pickSceneWeighted, BD_SCENES } from '@/lib/tryon/scene-pool'

const seq = (...vals: number[]) => {
  let i = 0
  return () => vals[Math.min(i++, vals.length - 1)]
}

describe('pickSceneWeighted', () => {
  it('uniform when no weights — first roll picks the first scene', () => {
    const picked = pickSceneWeighted({}, seq(0, 0, 0, 0, 0))
    expect(picked.scene.id).toBe(BD_SCENES[0].id)
  })

  it('a −3 weight disables the scene entirely', () => {
    const banned = BD_SCENES[0].id
    const picked = pickSceneWeighted({ [banned]: -3 }, seq(0, 0, 0, 0, 0))
    expect(picked.scene.id).not.toBe(banned)
  })

  it('a +5 weight dominates the pool', () => {
    const fav = BD_SCENES[2].id
    const weights = { [fav]: 5 }
    // 32 vs (n-1)*1 — a mid roll lands on the favourite
    const picked = pickSceneWeighted(weights, seq(0.5, 0, 0, 0, 0))
    expect(picked.scene.id).toBe(fav)
  })

  it('all scenes banned falls back to the full pool (never crashes)', () => {
    const weights = Object.fromEntries(BD_SCENES.map((s) => [s.id, -3]))
    const picked = pickSceneWeighted(weights, seq(0.1, 0, 0, 0, 0))
    expect(picked.scene).toBeDefined()
    expect(picked.pairPose).toBeTruthy()
  })

  it('is deterministic for the same rand sequence', () => {
    const a = pickSceneWeighted({ x: 2 }, seq(0.3, 0.1, 0.2, 0.4, 0.5))
    const b = pickSceneWeighted({ x: 2 }, seq(0.3, 0.1, 0.2, 0.4, 0.5))
    expect(a).toEqual(b)
  })
})
