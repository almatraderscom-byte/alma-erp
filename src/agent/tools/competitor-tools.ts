import { oxylabsConfigured, oxylabsSerpSearch, oxylabsFetchPage, logOxylabsUsage } from '@/lib/oxylabs/client'
import { learnFact } from '@/lib/knowledge-graph'
import { getCompetitorWatchlist, setCompetitorWatchlist, findCompetitorByName, type CompetitorEntry } from '@/lib/competitor-watchlist'
import { verifyOxylabsSpendApproval, consumeOxylabsApproval } from '@/agent/lib/oxylabs-approval'
import type { AgentTool } from './registry'

function productAttribute(product: string): string {
  return `product_research:${product.toLowerCase().trim()}`
}

function buildKnowledgeValue(
  competitor: CompetitorEntry,
  product: string,
  matches: Array<{ url: string; title: string; desc?: string }>,
  checkedAt: string,
): string {
  if (!matches.length) {
    return `${competitor.name} — "${product}": Google-এ product match পাওয়া যায়নি (${checkedAt})`
  }
  const lines = matches.slice(0, 3).map((m, i) => `${i + 1}. ${m.title} — ${m.url}`)
  return `${competitor.name} — "${product}" (${checkedAt}):\n${lines.join('\n')}`
}

const manage_competitor_watchlist: AgentTool = {
  name: 'manage_competitor_watchlist',
  description:
    'View, add, or remove competitors from the watchlist. The watchlist is owner-maintained — only add/remove ' +
    'when the owner explicitly names a competitor to track or asks to stop tracking one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove'] },
      name: { type: 'string', description: 'Competitor name (required for add/remove)' },
      url: { type: 'string', description: 'Competitor website URL (required for add)' },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action ?? '')
    const list = await getCompetitorWatchlist()

    if (action === 'list') {
      return { success: true, data: { competitors: list } }
    }
    if (action === 'add') {
      const name = String(input.name ?? '').trim()
      const url = String(input.url ?? '').trim()
      if (!name || !url) return { success: false, error: 'name and url required for add' }
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'url must start with http(s)://' }
      if (list.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: `${name} ইতোমধ্যে watchlist-এ আছে` }
      }
      const updated: CompetitorEntry[] = [...list, { name, url }]
      await setCompetitorWatchlist(updated)
      return { success: true, data: { competitors: updated, message: `${name} watchlist-এ যুক্ত হয়েছে` } }
    }
    if (action === 'remove') {
      const name = String(input.name ?? '').trim()
      if (!name) return { success: false, error: 'name required for remove' }
      const updated = list.filter(c => c.name.toLowerCase() !== name.toLowerCase())
      if (updated.length === list.length) return { success: false, error: `${name} watchlist-এ পাওয়া যায়নি` }
      await setCompetitorWatchlist(updated)
      return { success: true, data: { competitors: updated, message: `${name} watchlist থেকে সরানো হয়েছে` } }
    }
    return { success: false, error: `invalid action: ${action}` }
  },
}

const research_competitor: AgentTool = {
  name: 'research_competitor',
  description:
    'Research a competitor\'s pricing/products for a given item — either by name (must be on the watchlist; ' +
    'use manage_competitor_watchlist to check/add first) or a direct URL. Uses Oxylabs credits (1-2 calls). ' +
    'Saves findings to business knowledge so repeated lookups for the same product+competitor within ~7 days ' +
    'reuse the stored fact instead of re-researching — check recall_business_knowledge first if unsure. ' +
    'REQUIRES confirm_oxylabs_spend approval first, then pass spendApprovalId.',
  input_schema: {
    type: 'object' as const,
    properties: {
      competitorName: { type: 'string', description: 'Name from the watchlist' },
      url: { type: 'string', description: 'Direct competitor URL (alternative to competitorName, for one-off checks)' },
      product: { type: 'string', description: 'Product/keyword to research, e.g. "premium silk panjabi"' },
      spendApprovalId: { type: 'string', description: 'Required — from confirm_oxylabs_spend after owner approves' },
    },
    required: ['product', 'spendApprovalId'],
  },
  handler: async (input) => {
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing).' }
    }
    const conversationId = input.conversationId ? String(input.conversationId) : null
    const gate = await verifyOxylabsSpendApproval({
      approvalId: input.spendApprovalId ? String(input.spendApprovalId) : null,
      tool: 'research_competitor',
      input,
      conversationId,
    })
    if (!gate.ok) {
      return { success: false, error: gate.error, data: { needsOxylabsApproval: true, estimatedCredits: gate.estimatedCredits } }
    }

    const product = String(input.product ?? '').trim()
    if (!product) return { success: false, error: 'product is required' }

    let competitor: CompetitorEntry | null = null
    if (input.competitorName) {
      competitor = await findCompetitorByName(String(input.competitorName))
      if (!competitor) {
        return {
          success: false,
          error: `"${input.competitorName}" watchlist-এ নেই — manage_competitor_watchlist (action=add) দিয়ে যুক্ত করুন, বা url সরাসরি দিন।`,
        }
      }
    } else if (input.url) {
      const url = String(input.url).trim()
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'url must start with http(s)://' }
      competitor = { name: new URL(url).hostname.replace(/^www\./, ''), url }
    } else {
      return { success: false, error: 'Provide either competitorName or url' }
    }

    const domain = new URL(competitor.url).hostname.replace(/^www\./, '')
    const query = `${product} site:${domain}`
    const result = await oxylabsSerpSearch(query, { limit: 5 })
    void logOxylabsUsage({ tool: 'research_competitor', query, success: result.success })
    if (!result.success) return { success: false, error: result.error }

    const matches = result.results ?? []
    let pageContent: string | null = null
    if (matches.length > 0 && matches[0].url) {
      const fetchResult = await oxylabsFetchPage(matches[0].url)
      void logOxylabsUsage({ tool: 'research_competitor_fetch', query: matches[0].url, success: fetchResult.success })
      if (fetchResult.success) {
        pageContent = (fetchResult.content ?? '').slice(0, 4000)
      }
    }

    const checkedAt = new Date().toISOString().slice(0, 10)
    const topMatches = matches.slice(0, 3).map(m => ({ url: m.url, title: m.title, desc: m.desc }))
    await learnFact({
      entityType: 'competitor',
      entityId: domain,
      entityName: competitor.name,
      attribute: productAttribute(product),
      value: buildKnowledgeValue(competitor, product, topMatches, checkedAt),
      source: 'research_competitor',
      confidenceDelta: 0.1,
    })

    await consumeOxylabsApproval(gate.approvalId)

    return {
      success: true,
      data: {
        competitor: competitor.name,
        product,
        topMatches,
        pageContentPreview: pageContent,
        note: 'pageContentPreview-এ price/availability খুঁজে owner-কে সংক্ষেপে জানান। নিজে কোনো price/offer change করবেন না — শুধু তথ্য।',
      },
    }
  },
}

export const COMPETITOR_TOOLS: AgentTool[] = [manage_competitor_watchlist, research_competitor]

export const COMPETITOR_ROLE_PROMPT = `
## কম্পিটিটর রিসার্চ
manage_competitor_watchlist দিয়ে owner-নির্ধারিত কম্পিটিটর লিস্ট দেখুন/manage করুন।
research_competitor দিয়ে কোনো প্রোডাক্টের কম্পিটিটর price/availability চেক করুন — **আগে confirm_oxylabs_spend** (১–২ ক্রেডিট), owner Approve ছাড়া research চালাবেন না।
**আগে recall_business_knowledge (entityType=competitor) চেক করুন** — সম্প্রতি (৭ দিনের মধ্যে) একই product+competitor research করা থাকলে আবার করবেন না।
শুধু তথ্য দিন — কোনো price/offer/website change নিজে থেকে করবেন না; owner কে জানিয়ে suggestion দিন।
`
