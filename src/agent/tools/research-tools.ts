import { oxylabsConfigured, oxylabsSerpSearch, oxylabsFetchPage, logOxylabsUsage } from '@/lib/oxylabs/client'
import {
  estimateOxylabsCredits,
  oxylabsInputFingerprint,
  verifyOxylabsSpendApproval,
  consumeOxylabsApproval,
  type OxylabsResearchTool,
} from '@/agent/lib/oxylabs-approval'
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const confirm_oxylabs_spend: AgentTool = {
  name: 'confirm_oxylabs_spend',
  description:
    'MANDATORY before web_research, research_competitor, or research_seo_keywords. Creates an owner approval card ' +
    'showing estimated Oxylabs credits (১–২). Research tools are BLOCKED until owner approves. ' +
    'After approval, call the research tool with spendApprovalId from the approval response.',
  input_schema: {
    type: 'object' as const,
    properties: {
      tool: {
        type: 'string',
        enum: ['web_research', 'research_competitor', 'research_seo_keywords'],
        description: 'Which research tool will run after approval',
      },
      purpose: { type: 'string', description: 'Short Bangla explanation why this research is needed' },
      toolInput: {
        type: 'object',
        description: 'Exact input you will pass to the research tool (mode/query/url/keyword/product etc.)',
      },
      conversationId: { type: 'string' },
    },
    required: ['tool', 'purpose', 'toolInput'],
  },
  handler: async (input) => {
    const tool = String(input.tool ?? '') as OxylabsResearchTool
    const purpose = String(input.purpose ?? '').trim()
    const toolInput = (input.toolInput && typeof input.toolInput === 'object')
      ? (input.toolInput as Record<string, unknown>)
      : {}
    const conversationId = input.conversationId ? String(input.conversationId) : null

    if (!purpose) return { success: false, error: 'purpose is required' }
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing).' }
    }

    const estimatedCredits = estimateOxylabsCredits(tool, toolInput)
    const fingerprint = oxylabsInputFingerprint(tool, toolInput)
    const summary =
      `🔍 Oxylabs ওয়েব রিসার্চ\n` +
      `কাজ: ${purpose}\n` +
      `টুল: ${tool}\n` +
      `আনুমানিক খরচ: ${estimatedCredits} Oxylabs ক্রেডিট\n\n` +
      `Approve করলে research চালানো হবে — Reject করলে কোনো ক্রেডিট খরচ হবে না।`

    const action = await db.agentPendingAction.create({
      data: {
        conversationId,
        type: 'oxylabs_spend',
        payload: { tool, purpose, toolInput, inputFingerprint: fingerprint, conversationId, estimatedCredits },
        summary,
        costEstimate: estimatedCredits,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: {
        pendingActionId: action.id as string,
        summary,
        costEstimate: estimatedCredits,
        actionType: 'oxylabs_spend',
        estimatedCredits,
        message: 'Owner-approval card তৈরি হয়েছে — Approve হলে spendApprovalId দিয়ে research tool চালান।',
      },
    }
  },
}

async function gateOxylabs(
  tool: OxylabsResearchTool,
  input: Record<string, unknown>,
  conversationId: string | null,
) {
  const spendApprovalId = input.spendApprovalId ? String(input.spendApprovalId) : null
  const gate = await verifyOxylabsSpendApproval({
    approvalId: spendApprovalId,
    tool,
    input,
    conversationId,
  })
  if (!gate.ok) {
    return { blocked: true as const, error: gate.error, estimatedCredits: gate.estimatedCredits }
  }
  return { blocked: false as const, approvalId: gate.approvalId }
}

const web_research: AgentTool = {
  name: 'web_research',
  description:
    'Research the web for ALMA business purposes — competitor prices/products, market trends, SEO keyword ' +
    'rankings, supplier info, fashion/trading industry news. Two modes: "search" (Google search results for a ' +
    'query) or "fetch" (read a specific competitor/reference URL). Uses prepaid Oxylabs credits — use sparingly ' +
    'and only when the answer genuinely requires live web data (not for things knowable from memory/training). ' +
    'NEVER use for unrelated/general topics outside ALMA Lifestyle/Trading business context. ' +
    'REQUIRES confirm_oxylabs_spend approval first, then pass spendApprovalId.',
  input_schema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['search', 'fetch'], description: '"search" = Google query, "fetch" = read a URL' },
      query: { type: 'string', description: 'Search query (mode=search) — be specific, e.g. "premium panjabi price Dhaka 2026"' },
      url: { type: 'string', description: 'Full URL to fetch (mode=fetch) — e.g. a competitor product/category page' },
      limit: { type: 'number', description: 'Max search results to return (mode=search, default 5, max 10)' },
      spendApprovalId: { type: 'string', description: 'Required — from confirm_oxylabs_spend after owner approves' },
    },
    required: ['mode', 'spendApprovalId'],
  },
  handler: async (input) => {
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing — copy from Hostinger Docker Manager).' }
    }
    const mode = String(input.mode ?? '')
    const conversationId = input.conversationId ? String(input.conversationId) : null

    const gate = await gateOxylabs('web_research', input, conversationId)
    if (gate.blocked) {
      return { success: false, error: gate.error, data: { needsOxylabsApproval: true, estimatedCredits: gate.estimatedCredits } }
    }

    if (mode === 'search') {
      const query = String(input.query ?? '').trim()
      if (!query) return { success: false, error: 'query is required for mode=search' }
      const limit = Math.min(Number(input.limit ?? 5), 10)
      const result = await oxylabsSerpSearch(query, { limit })
      void logOxylabsUsage({ tool: 'web_research_search', query, success: result.success, conversationId })
      if (!result.success) return { success: false, error: result.error }
      await consumeOxylabsApproval(gate.approvalId)
      return { success: true, data: { query, results: result.results } }
    }

    if (mode === 'fetch') {
      const url = String(input.url ?? '').trim()
      if (!url) return { success: false, error: 'url is required for mode=fetch' }
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'url must start with http(s)://' }
      const result = await oxylabsFetchPage(url)
      void logOxylabsUsage({ tool: 'web_research_fetch', query: url, success: result.success, conversationId })
      if (!result.success) return { success: false, error: result.error }
      await consumeOxylabsApproval(gate.approvalId)
      const content = (result.content ?? '').slice(0, 8000)
      return { success: true, data: { url, content } }
    }

    return { success: false, error: `invalid mode: ${mode}` }
  },
}

export const RESEARCH_TOOLS: AgentTool[] = [confirm_oxylabs_spend, web_research]

export const RESEARCH_ROLE_PROMPT = `
## ওয়েব রিসার্চ (Oxylabs)
**বাধ্যতামূলক:** web_research/research_competitor/research_seo_keywords-এর আগে confirm_oxylabs_spend — owner Approve না করলে research চালাবেন না (ক্রেডিট খরচ হবে না)।
Approve হলে spendApprovalId দিয়ে research tool চালান।
web_research দিয়ে competitor price/product, SEO keyword, market trend, supplier info খুঁজতে পারেন।
**সতর্কতা — credit সীমিত (prepaid):**
- প্রতিটা কল ≈ ১ ক্রেডিট (competitor+fetch ≈ ২)।
- generic question / general knowledge-এর জন্য কখনোই ব্যবহার করবেন না — শুধু ALMA Lifestyle/Trading business-related research।
- একই query repeat করবেন না; আগের research result এই conversation-এ থাকলে আবার call করবেন না।
- mode=fetch ব্যবহার করার আগে mode=search দিয়ে আগে দেখুন প্রয়োজনীয় URL কোনটা — অপ্রয়োজনীয় fetch এড়ান।
`
