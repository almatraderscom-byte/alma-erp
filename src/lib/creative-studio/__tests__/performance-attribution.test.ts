import { describe, expect, it } from 'vitest'
import {
  deterministicPerformanceScore,
  nextDeterministicSceneWeight,
  normalizePerformanceMetrics,
  performanceSourceFingerprint,
  selectDeterministicPerformanceWinner,
} from '@/lib/creative-studio/performance-attribution'

describe('CSE7 deterministic performance attribution', () => {
  it('maps metrics into a reproducible score without creative judgment', () => {
    expect(deterministicPerformanceScore({
      reach: 1_000,
      engagements: 50,
      clicks: 20,
      conversions: 2,
    })).toBe(1_460)
    expect(nextDeterministicSceneWeight(100)).toBe(105)
    expect(nextDeterministicSceneWeight(149)).toBe(150)
  })

  it('requires two versions, 100 impressions, and a ten-percent winner margin', () => {
    const winner = selectDeterministicPerformanceWinner([
      {
        snapshotId: 'snapshot-a',
        assetVersionId: 'version-a',
        sceneKey: 'hero-4x5',
        reach: 1_000,
        impressions: 1_200,
        engagements: 100,
        clicks: 40,
        conversions: 2,
      },
      {
        snapshotId: 'snapshot-b',
        assetVersionId: 'version-b',
        sceneKey: 'post-1x1',
        reach: 700,
        impressions: 1_000,
        engagements: 60,
        clicks: 20,
        conversions: 1,
      },
    ])
    expect(winner).toMatchObject({
      snapshotId: 'snapshot-a',
      assetVersionId: 'version-a',
      sceneKey: 'hero-4x5',
    })
    expect(selectDeterministicPerformanceWinner([
      {
        snapshotId: 'a',
        assetVersionId: 'a',
        sceneKey: 'hero',
        reach: 100,
        impressions: 99,
        engagements: 0,
        clicks: 0,
        conversions: 0,
      },
      {
        snapshotId: 'b',
        assetVersionId: 'b',
        sceneKey: 'post',
        reach: 90,
        impressions: 99,
        engagements: 0,
        clicks: 0,
        conversions: 0,
      },
    ])).toBeNull()
  })

  it('normalizes generic spend separately from whole-taka revenue and deduplicates a source window', () => {
    const metrics = normalizePerformanceMetrics({
      externalObjectId: 'ad-1',
      sourceWindow: '2026-07-01:2026-07-25',
      reach: 100.4,
      impressions: 120.6,
      engagements: 7,
      clicks: 3,
      conversions: 1,
      spendAmount: 12.345,
      spendCurrency: 'usd',
      revenueBdt: 1_234.6,
      raw: { provider: 'meta' },
    })
    expect(metrics).toMatchObject({
      reach: 100,
      impressions: 121,
      spendAmount: 12.35,
      spendCurrency: 'USD',
      revenueBdt: 1_235,
    })
    const fingerprint = performanceSourceFingerprint({
      deliveryId: 'delivery-1',
      sourceWindow: metrics.sourceWindow,
      metrics,
    })
    expect(fingerprint).toHaveLength(64)
    expect(performanceSourceFingerprint({
      deliveryId: 'delivery-1',
      sourceWindow: metrics.sourceWindow,
      metrics,
    })).toBe(fingerprint)
  })
})
