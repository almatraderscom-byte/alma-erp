import { describe, it, expect } from 'vitest'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'

const OWNER = { personalMode: false, businessId: 'ALMA_LIFESTYLE' as const }

/**
 * Prompt-cache prefix stability: for owner business chat, the tool list (which
 * sits at the very front of the cached prefix) MUST be byte-identical between
 * any two messages. If it varies, the whole cached prefix is invalidated and
 * rewritten at the expensive cache-WRITE rate every turn — the root cause of the
 * ~$0.11/message cost. These tests lock the fix in place.
 */
describe('owner-chat tool prefix is stable across messages', () => {
  it('two very different owner messages produce IDENTICAL tool lists', async () => {
    const a = await selectToolsAndGroupsForTurnAsync('একটা Facebook পোস্ট ড্রাফট করো', OWNER)
    const b = await selectToolsAndGroupsForTurnAsync('Product library-তে add করে content engine চালু করো', OWNER)
    expect(a.tools.map((t) => t.name)).toEqual(b.tools.map((t) => t.name))
    expect(a.groups).toEqual(b.groups)
  })

  it('a greeting and a marketing ask also produce IDENTICAL tool lists', async () => {
    const a = await selectToolsAndGroupsForTurnAsync('assalamu alaikum', OWNER)
    const b = await selectToolsAndGroupsForTurnAsync('marketing plan banao next month er jonno', OWNER)
    expect(a.tools.map((t) => t.name)).toEqual(b.tools.map((t) => t.name))
  })

  it('stable set exposes core business tools across domains', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('ajker sales koto', OWNER)
    const names = tools.map((t) => t.name)
    for (const tool of [
      'get_sales_summary', // erp
      'get_staff_tasks', // staff
      'get_expense_summary', // finance
      'run_content_post', // content
      'plan_marketing', // growth
      'get_website_catalog', // website
      'get_api_balances', // cost
    ]) {
      expect(names).toContain(tool)
    }
  })

  it('last tool carries the cache_control breakpoint', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('hi', OWNER)
    const last = tools[tools.length - 1] as { cache_control?: { type: string; ttl?: string } }
    expect(last.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('personal mode keeps its narrow stable set', async () => {
    const { groups } = await selectToolsAndGroupsForTurnAsync('remind me to call doctor', {
      personalMode: true,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(groups).toEqual(['personal'])
  })

  it('ALMA Trading keeps its narrow stable set', async () => {
    const { groups } = await selectToolsAndGroupsForTurnAsync('account balance dekhao', {
      personalMode: false,
      businessId: 'ALMA_TRADING',
    })
    expect(groups).toContain('trading')
  })
})
