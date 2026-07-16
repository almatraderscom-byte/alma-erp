import { describe, expect, it } from 'vitest'
import {
  clientSeoBatchIsReadyForPack,
  clientSeoBatchRequiredTool,
  createClientSeoBatchFacts,
  reduceClientSeoBatch,
} from '@/agent/lib/client-seo-batch-state'

describe('durable ordered client SEO batch', () => {
  it('cannot skip Chrome evidence, report, links, or the second target', () => {
    let f = createClientSeoBatchFacts(['https://one.com', 'https://two.com'], {
      requireLiveBrowser: true,
      requireArtifact: true,
    })
    expect(clientSeoBatchRequiredTool(f)).toBe('live_browser_act')
    for (let i = 0; i < 5; i++) {
      f = reduceClientSeoBatch(f, { type: 'browser_act' })
      expect(clientSeoBatchRequiredTool(f)).toBe('live_browser_look')
      f = reduceClientSeoBatch(f, { type: 'browser_look', url: `https://one.com/page-${i}` })
    }
    expect(clientSeoBatchRequiredTool(f)).toBe('run_website_seo_audit')
    f = reduceClientSeoBatch(f, { type: 'audit_queued', actionId: 'audit-1' })
    expect(clientSeoBatchRequiredTool(f)).toBeNull()
    f = reduceClientSeoBatch(f, { type: 'audit_finished', actionId: 'audit-1', ok: true })
    expect(clientSeoBatchRequiredTool(f)).toBe('check_website_seo_audit')
    f = reduceClientSeoBatch(f, { type: 'report_read', actionId: 'audit-1' })
    f = reduceClientSeoBatch(f, { type: 'links_read', actionId: 'audit-1' })
    expect(f.currentIndex).toBe(1)
    expect(clientSeoBatchRequiredTool(f)).toBe('live_browser_act')
    expect(clientSeoBatchIsReadyForPack(f)).toBe(false)
  })

  it('counts only distinct pages on the current host and completes only after every target', () => {
    let f = createClientSeoBatchFacts(['https://one.com', 'https://two.com'], {
      requireLiveBrowser: true,
      requireArtifact: true,
    })
    for (let targetIndex = 0; targetIndex < 2; targetIndex++) {
      const host = targetIndex === 0 ? 'one.com' : 'two.com'
      f = reduceClientSeoBatch(f, { type: 'browser_look', url: 'https://unrelated.com/' })
      f = reduceClientSeoBatch(f, { type: 'browser_look', url: `https://${host}/same` })
      f = reduceClientSeoBatch(f, { type: 'browser_look', url: `https://${host}/same` })
      expect(f.targets[targetIndex].browserPages).toHaveLength(1)
      for (let page = 1; page < 5; page++) {
        f = reduceClientSeoBatch(f, { type: 'browser_look', url: `https://${host}/page-${page}` })
      }
      const actionId = `audit-${targetIndex + 1}`
      f = reduceClientSeoBatch(f, { type: 'audit_queued', actionId })
      f = reduceClientSeoBatch(f, { type: 'audit_finished', actionId, ok: true })
      f = reduceClientSeoBatch(f, { type: 'report_read', actionId })
      expect(clientSeoBatchIsReadyForPack(f)).toBe(false)
      f = reduceClientSeoBatch(f, { type: 'links_read', actionId })
    }
    expect(clientSeoBatchIsReadyForPack(f)).toBe(true)
    expect(clientSeoBatchRequiredTool(f)).toBe('complete_skill_pack_run')
  })
})

describe('redirect-collapsed target (2026-07-16 gulshanspaone incident)', () => {
  it('a target that redirects into another listed target satisfies its browser requirement via the redirect', () => {
    let f = createClientSeoBatchFacts(['https://one.com', 'https://two.com'], {
      requireLiveBrowser: true,
      requireArtifact: false,
    })
    // Agent navigates one.com; the look lands on two.com (301 collapse).
    f = reduceClientSeoBatch(f, { type: 'browser_act' })
    f = reduceClientSeoBatch(f, { type: 'browser_look', url: 'https://two.com/service' })
    expect(f.targets[0].redirectsToHost).toBe('two.com')
    // one.com's browser requirement is waived — flow moves to its audit.
    expect(clientSeoBatchRequiredTool(f)).toBe('run_website_seo_audit')
    // The observed page was credited to two.com, not lost.
    expect(f.targets[1].browserPages.map((p) => p.url)).toContain('https://two.com/service')

    // Complete target 1 (audit reuses the destination's data in practice).
    f = reduceClientSeoBatch(f, { type: 'audit_queued', actionId: 'a1' })
    f = reduceClientSeoBatch(f, { type: 'audit_finished', actionId: 'a1', ok: true })
    f = reduceClientSeoBatch(f, { type: 'report_read', actionId: 'a1' })
    f = reduceClientSeoBatch(f, { type: 'links_read', actionId: 'a1' })
    expect(f.currentIndex).toBe(1)

    // Target 2 walks its own pages normally (one already credited).
    for (let i = 0; i < 4; i++) {
      f = reduceClientSeoBatch(f, { type: 'browser_act' })
      f = reduceClientSeoBatch(f, { type: 'browser_look', url: `https://two.com/p${i}` })
    }
    expect(clientSeoBatchRequiredTool(f)).toBe('run_website_seo_audit')
    f = reduceClientSeoBatch(f, { type: 'audit_queued', actionId: 'a2' })
    f = reduceClientSeoBatch(f, { type: 'audit_finished', actionId: 'a2', ok: true })
    f = reduceClientSeoBatch(f, { type: 'report_read', actionId: 'a2' })
    f = reduceClientSeoBatch(f, { type: 'links_read', actionId: 'a2' })
    // Redirect-collapsed target must not block pack readiness.
    expect(clientSeoBatchIsReadyForPack(f)).toBe(true)
  })
})
