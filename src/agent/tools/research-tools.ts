import { oxylabsConfigured, oxylabsSerpSearch, oxylabsFetchPage, logOxylabsUsage } from '@/lib/oxylabs/client'
import type { AgentTool } from './registry'

const web_research: AgentTool = {
  name: 'web_research',
  description:
    'Research the web for ALMA business purposes — competitor prices/products, market trends, SEO keyword ' +
    'rankings, supplier info, fashion/trading industry news. Two modes: "search" (Google search results for a ' +
    'query) or "fetch" (read a specific competitor/reference URL). Uses prepaid Oxylabs credits — use sparingly ' +
    'and only when the answer genuinely requires live web data (not for things knowable from memory/training). ' +
    'NEVER use for unrelated/general topics outside ALMA Lifestyle/Trading business context.',
  input_schema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['search', 'fetch'], description: '"search" = Google query, "fetch" = read a URL' },
      query: { type: 'string', description: 'Search query (mode=search) — be specific, e.g. "premium panjabi price Dhaka 2026"' },
      url: { type: 'string', description: 'Full URL to fetch (mode=fetch) — e.g. a competitor product/category page' },
      limit: { type: 'number', description: 'Max search results to return (mode=search, default 5, max 10)' },
    },
    required: ['mode'],
  },
  handler: async (input) => {
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing — copy from Hostinger Docker Manager).' }
    }
    const mode = String(input.mode ?? '')
    const conversationId = input.conversationId ? String(input.conversationId) : null

    if (mode === 'search') {
      const query = String(input.query ?? '').trim()
      if (!query) return { success: false, error: 'query is required for mode=search' }
      const limit = Math.min(Number(input.limit ?? 5), 10)
      const result = await oxylabsSerpSearch(query, { limit })
      void logOxylabsUsage({ tool: 'web_research_search', query, success: result.success, conversationId })
      if (!result.success) return { success: false, error: result.error }
      return { success: true, data: { query, results: result.results } }
    }

    if (mode === 'fetch') {
      const url = String(input.url ?? '').trim()
      if (!url) return { success: false, error: 'url is required for mode=fetch' }
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'url must start with http(s)://' }
      const result = await oxylabsFetchPage(url)
      void logOxylabsUsage({ tool: 'web_research_fetch', query: url, success: result.success, conversationId })
      if (!result.success) return { success: false, error: result.error }
      const content = (result.content ?? '').slice(0, 8000)
      return { success: true, data: { url, content } }
    }

    return { success: false, error: `invalid mode: ${mode}` }
  },
}

export const RESEARCH_TOOLS: AgentTool[] = [web_research]

export const RESEARCH_ROLE_PROMPT = `
## ওয়েব রিসার্চ (Oxylabs)
web_research দিয়ে competitor price/product, SEO keyword, market trend, supplier info খুঁজতে পারেন।
**সতর্কতা — credit সীমিত (1000 prepaid):**
- প্রতিটা কল credit খরচ করে। শুধু তখনই ব্যবহার করুন যখন সত্যিই live web data লাগবে।
- generic question / general knowledge-এর জন্য কখনোই ব্যবহার করবেন না — শুধু ALMA Lifestyle/Trading business-related research।
- একই query repeat করবেন না; আগের research result এই conversation-এ থাকলে আবার call করবেন না।
- mode=fetch ব্যবহার করার আগে mode=search দিয়ে আগে দেখুন প্রয়োজনীয় URL কোনটা — অপ্রয়োজনীয় fetch এড়ান।
`
