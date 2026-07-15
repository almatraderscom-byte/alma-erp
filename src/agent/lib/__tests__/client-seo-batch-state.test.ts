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
