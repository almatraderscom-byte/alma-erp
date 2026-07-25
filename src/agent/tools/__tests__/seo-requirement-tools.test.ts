/**
 * Live production run 2026-07-25, the one that mattered: Boss's audit request
 * came back as "⏳ Ordered SEO কাজ চলমান … পরের ধাপ: run_website_seo_audit" with
 * zero model tokens spent. Cause: the state router only SHADOW-logs in
 * production, so the legacy selector chose the tools — and for this exact
 * message it loads no SEO audit tools at all. The contract demanded a tool the
 * head did not have.
 *
 * This locks the gap itself: the selector's own output for the owner's message.
 * run-owner-turn now injects the requirement's tools regardless of selector.
 */
import { describe, expect, it } from 'vitest'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'
import { resolveToolsByName } from '@/agent/tools/find-tool'

const OWNER_MESSAGE = 'Do a Deep SEO Audit - almatraders.com'
const REQUIRED = ['run_website_seo_audit', 'check_website_seo_audit', 'save_artifact']

describe('SEO requirement tools are reachable however the turn was routed', () => {
  it('documents that the legacy selector alone does NOT supply them', async () => {
    const selected = await selectToolsAndGroupsForTurnAsync(OWNER_MESSAGE, {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      headTier: 'heavy',
    })
    const names = new Set((selected.tools as Array<{ name: string }>).map((t) => t.name))
    // If this ever starts passing, the legacy selector learned SEO — good, and
    // the injection below simply becomes a no-op. It must never be the only
    // thing standing between Boss and his audit.
    expect(names.has('run_website_seo_audit')).toBe(false)
  })

  it('resolves every tool the client-SEO contract can demand', async () => {
    const resolved = await resolveToolsByName(REQUIRED)
    expect(resolved.map((t) => t.name).sort()).toEqual([...REQUIRED].sort())
    for (const tool of resolved) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.input_schema).toBeTruthy()
    }
  })
})
