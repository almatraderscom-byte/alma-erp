import { describe, it, expect } from 'vitest'
import {
  deriveStatus,
  redactSecrets,
  buildMatrix,
  META_VERSION_CALL_SITES,
  type CapabilityCheck,
} from '@/agent/lib/marketing/capability-audit'
import {
  detectThinSample,
  detectFunnelBreak,
  detectAttributionGaps,
} from '@/agent/lib/marketing/measurement-health'

describe('deriveStatus — env presence never yields green', () => {
  it('not configured → unsupported', () => {
    expect(deriveStatus({ configured: false, probeRan: false, probeOk: false })).toBe('unsupported')
    expect(deriveStatus({ configured: false, probeRan: true, probeOk: true })).toBe('unsupported')
  })

  it('configured but never probed → unknown (NOT read/green)', () => {
    expect(deriveStatus({ configured: true, probeRan: false, probeOk: false })).toBe('unknown')
    expect(deriveStatus({ configured: true, probeRan: false, probeOk: true, provenLevel: 'stage' })).toBe('unknown')
  })

  it('configured + probe failed → broken', () => {
    expect(deriveStatus({ configured: true, probeRan: true, probeOk: false })).toBe('broken')
    expect(deriveStatus({ configured: true, probeRan: true, probeOk: false, provenLevel: 'stage' })).toBe('broken')
  })

  it('configured + probe ok → proven level (default read)', () => {
    expect(deriveStatus({ configured: true, probeRan: true, probeOk: true })).toBe('read')
    expect(deriveStatus({ configured: true, probeRan: true, probeOk: true, provenLevel: 'stage' })).toBe('stage')
    expect(deriveStatus({ configured: true, probeRan: true, probeOk: true, provenLevel: 'draft' })).toBe('draft')
  })

  it('write-confirmed can never come out of this audit', () => {
    const all: Array<ReturnType<typeof deriveStatus>> = []
    for (const configured of [true, false])
      for (const probeRan of [true, false])
        for (const probeOk of [true, false])
          for (const provenLevel of ['read', 'draft', 'stage', undefined] as const)
            all.push(deriveStatus({ configured, probeRan, probeOk, provenLevel }))
    expect(all).not.toContain('write-confirmed')
  })
})

describe('redactSecrets', () => {
  it('masks long token-like strings, keeps short ids', () => {
    const msg = 'token EAAGm0ZBZCZBxyzVeryLongSecretToken12345 failed for page 1044848232034171'
    const out = redactSecrets(msg)
    expect(out).not.toContain('EAAGm0ZBZCZBxyzVeryLongSecretToken12345')
    expect(out).toContain('…2345')
    // 16-digit page id stays readable (identification, not a secret)
    expect(out).toContain('1044848232034171')
  })
})

describe('buildMatrix', () => {
  const mk = (status: CapabilityCheck['status']): CapabilityCheck => ({
    key: `k_${status}`,
    area: 'meta',
    label: 'x',
    status,
    scope: 's',
    evidence: 'e',
  })

  it('counts proven/broken/unknown/unsupported honestly', () => {
    const m = buildMatrix([mk('read'), mk('stage'), mk('broken'), mk('unknown'), mk('unsupported')], '2026-07-17T00:00:00Z')
    expect(m.summary).toEqual({ total: 5, proven: 2, broken: 1, unknown: 1, unsupported: 1 })
    expect(m.checkedAt).toBe('2026-07-17T00:00:00Z')
  })

  it('carries the central Meta version call-site list (non-empty, includes core client)', () => {
    const m = buildMatrix([], 'now')
    expect(m.metaVersionCallSites.length).toBeGreaterThan(10)
    expect(m.metaVersionCallSites).toContain('src/agent/lib/meta.ts')
    expect(m.metaVersionCallSites).toContain('worker/src/ads/monitor.mjs')
    expect(META_VERSION_CALL_SITES).toContain('src/agent/lib/meta-ads.ts')
  })
})

describe('measurement-health gap detectors', () => {
  it('thin sample: below threshold flags, at/above passes', () => {
    expect(detectThinSample(0, 7, 'orders')?.severity).toBe('high')
    expect(detectThinSample(2, 7, 'orders')?.severity).toBe('medium')
    expect(detectThinSample(3, 7, 'orders')).toBeNull()
  })

  it('thin sample threshold scales with window', () => {
    // 30-day window → threshold max(3, 15) = 15
    expect(detectThinSample(14, 30, 'orders')).not.toBeNull()
    expect(detectThinSample(15, 30, 'orders')).toBeNull()
  })

  it('funnel break: orders with zero delivered over ≥7d is high severity', () => {
    const gap = detectFunnelBreak(10, 0, 14)
    expect(gap?.kind).toBe('funnel_break')
    expect(gap?.severity).toBe('high')
  })

  it('funnel break: delivered unknown is medium, no orders is fine', () => {
    expect(detectFunnelBreak(5, null, 7)?.severity).toBe('medium')
    expect(detectFunnelBreak(0, null, 7)).toBeNull()
    expect(detectFunnelBreak(10, 6, 7)).toBeNull()
  })

  it('attribution gaps: spend without GA4 = high; spend+orders = uncertain (low); orders without spend = medium', () => {
    const gaps = detectAttributionGaps({ spend: 5000, ga4Observed: false, orders: 12 })
    expect(gaps.map((g) => g.kind)).toContain('missing_analytics')
    expect(gaps.map((g) => g.kind)).toContain('attribution_uncertain')

    const organicOnly = detectAttributionGaps({ spend: 0, ga4Observed: true, orders: 8 })
    expect(organicOnly.map((g) => g.kind)).toEqual(['missing_spend'])

    const clean = detectAttributionGaps({ spend: 0, ga4Observed: true, orders: 0 })
    expect(clean).toEqual([])
  })
})
