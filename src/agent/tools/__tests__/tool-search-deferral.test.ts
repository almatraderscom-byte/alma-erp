import { describe, it, expect } from 'vitest'
import { selectToolsAndGroupsForTurnAsync, applyToolSearchDeferral } from '@/agent/tools/select-tools'

const OWNER = { personalMode: false, businessId: 'ALMA_LIFESTYLE' as const }

/**
 * Tool Search (deferred tool loading) — the Claude-Code-style cost fix.
 * Everyday tools stay fully loaded; the specialised long tail is marked
 * `defer_loading` and pulled on demand via the regex tool-search tool. These
 * tests lock the split + the single cache breakpoint in place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const named = (t: any) => t as { name?: string; type?: string; defer_loading?: boolean; cache_control?: unknown }

describe('applyToolSearchDeferral', () => {
  it('keeps everyday tools loaded and defers the specialised long tail', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('ajker sales koto', OWNER)
    const out = applyToolSearchDeferral(tools)
    const byName = new Map(out.map((t) => [named(t).name, named(t)]))

    // everyday tools (base/erp/staff/finance) stay fully loaded — no defer_loading
    for (const n of ['get_sales_summary', 'get_staff_tasks', 'get_expense_summary']) {
      expect(byName.get(n)?.defer_loading).toBeUndefined()
    }
    // specialised long-tail tools (content/growth/website/cost) are deferred
    for (const n of ['run_content_post', 'plan_marketing', 'get_website_catalog', 'get_api_balances']) {
      expect(byName.get(n)?.defer_loading).toBe(true)
    }
  })

  it('appends the regex tool-search tool exactly once', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('hi', OWNER)
    const out = applyToolSearchDeferral(tools)
    const searchTools = out.filter((t) => named(t).type === 'tool_search_tool_regex_20251119')
    expect(searchTools.length).toBe(1)
  })

  it('has exactly one cache breakpoint, on the last element', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('hi', OWNER)
    const out = applyToolSearchDeferral(tools)
    const withCacheControl = out.filter((t) => named(t).cache_control)
    expect(withCacheControl.length).toBe(1)
    expect(named(out[out.length - 1]).cache_control).toEqual({ type: 'ephemeral' })
  })
})
