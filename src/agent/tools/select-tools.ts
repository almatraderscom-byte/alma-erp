import type Anthropic from '@anthropic-ai/sdk'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { TOOL_GROUPS, type ToolGroupName } from '@/agent/tools/tool-groups'
import type { AgentTool } from '@/agent/tools/registry'
import { semanticGroups } from '@/agent/tools/semantic-router'

const AMBIGUOUS_FALLBACK: ToolGroupName[] = ['erp', 'staff']

const SHORT_GREETING_RE =
  /^(hei|hi|hello|hey|hii|ok|okay|thanks|thank you|dhonnobad|ধন্যবাদ|kemon|ki khobor|কেমন|কি খবর|assalam|salam|আসসালাম|salamu|জি|ha|হ্যা|na|না)[\s!.?,]*$/i

export type ToolGroupResult = {
  groups: ToolGroupName[]
  confident: boolean
}

/**
 * Pure keyword-based tool-group selection (synchronous).
 * Returns groups and a confidence signal.
 */
export function selectToolGroupsSync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): ToolGroupResult {
  if (opts.personalMode) return { groups: ['personal'], confident: true }
  if (opts.businessId === 'ALMA_TRADING') return { groups: ['base', 'trading'], confident: true }

  const g = new Set<ToolGroupName>(['base'])
  const t = text.trim()

  if (t.length < 24 && SHORT_GREETING_RE.test(t)) {
    return { groups: ['base', 'erp'], confident: true }
  }

  if (t.length < 12 && g.size === 1) {
    return { groups: ['base', 'erp'], confident: true }
  }

  if (/staff|হাজিরা|টাস্ক|বেতন|fine|eyafi|mustahid|dispatch|approve|পাঠাও/i.test(t)) {
    g.add('staff')
    g.add('finance')
  }
  if (/order|stock|inventory|product|দাম|price|reorder|catalog/i.test(t)) g.add('erp')
  if (/customer|messenger|cs|winback|segment|inbox/i.test(t)) g.add('cs')
  if (/ad|বুস্ট|campaign|seo|competitor|গ্রো|marketing|intel|optimizer|ROAS|scale|plan_marketing|marketing_report|মার্কেটিং|ফানেল/i.test(t)) g.add('growth')
  if (/content|ছবি|image|post|model|try.?on|ব্র্যান্ড|facebook|fb|creative|অফার|offer|poster|reel|video|ভিডিও|রিল/i.test(t)) g.add('content')
  if (/website|almatraders|publish|catalog/i.test(t)) g.add('website')
  if (/salah|নামাজ|prayer|namaz|fajr|dhuhr|asr|maghrib|isha|ফজর|যোহর|আসর|মাগরিব|ইশা|জুম্মা|poreci|porlam|পড়েছি|পড়লাম|নামায/i.test(t)) g.add('salah')
  if (/expense|ledger|finance|খরচ|টাকা|bdt|aed|simulate|projection|what.?if|restock|break.?even/i.test(t)) g.add('finance')
  if (/সমস্যা|error|bug|diagnose|health|watchdog/i.test(t)) g.add('diag')
  if (/qc|screenshot|invoice|রসিদ|receipt|brand.?check|ছবি.*(?:check|দেখ|inspect)|photo.*(?:check|inspect|qc)|poster.*(?:check|read|দেখ)/i.test(t)) g.add('vision')

  if (g.size === 1) {
    for (const x of AMBIGUOUS_FALLBACK) g.add(x)
  }

  const groups = [...g]

  // Confident when keywords matched something beyond the base+ambiguous fallback,
  // or the message is trivially short/greeting
  const isAmbiguousFallback =
    g.size <= 3 &&
    groups.every(gr => gr === 'base' || AMBIGUOUS_FALLBACK.includes(gr))
  const isNonTrivial = t.length >= 24 && !SHORT_GREETING_RE.test(t)
  const confident = !(isAmbiguousFallback && isNonTrivial)

  return { groups, confident }
}

/** Backward-compatible wrapper — returns groups only. */
export function selectToolGroups(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): ToolGroupName[] {
  return selectToolGroupsSync(text, opts).groups
}

export function dedupeToolsByName(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>()
  const out: AgentTool[] = []
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }
  return out
}

export function assembleSelectedTools(groups: ToolGroupName[]): AgentTool[] {
  const merged = groups.flatMap((g) => TOOL_GROUPS[g] ?? [])
  return dedupeToolsByName(merged)
}

export function toolsToDefinitions(tools: AgentTool[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/** Cache breakpoint on the last tool — caches the whole tool prefix block. */
export function applyToolCacheControl(tools: Anthropic.Messages.Tool[]): Anthropic.Messages.Tool[] {
  if (tools.length === 0) return tools
  return tools.map((t, i) =>
    i === tools.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral' } } as Anthropic.Messages.Tool)
      : t,
  )
}

/** Synchronous tool selection (keyword-only). Used by tests and fast paths. */
export function selectToolsForTurnSync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Anthropic.Messages.Tool[] {
  const { groups } = selectToolGroupsSync(text, opts)
  const tools = assembleSelectedTools(groups)
  return applyToolCacheControl(toolsToDefinitions(tools))
}

/** Keep old sync name working for existing call sites during migration. */
export function selectToolsForTurn(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Anthropic.Messages.Tool[] {
  return selectToolsForTurnSync(text, opts)
}

const WIDE_FALLBACK: ToolGroupName[] = ['base', 'erp', 'staff', 'finance']

/**
 * Async hybrid tool selection: keyword fast-path when confident,
 * semantic embedding fallback when ambiguous.
 */
export async function selectToolsForTurnAsync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Promise<Anthropic.Messages.Tool[]> {
  const { groups, confident } = selectToolGroupsSync(text, opts)

  if (confident) {
    const tools = assembleSelectedTools(groups)
    return applyToolCacheControl(toolsToDefinitions(tools))
  }

  // Low confidence — try semantic fallback
  try {
    const semGroups = await semanticGroups(text)
    if (semGroups.length > 0) {
      const merged = new Set<ToolGroupName>([...groups, ...semGroups])
      const tools = assembleSelectedTools([...merged])
      return applyToolCacheControl(toolsToDefinitions(tools))
    }
  } catch {
    // Embedding unavailable — widen fallback
  }

  // Widen to safe defaults so agent isn't capability-starved
  const widened = new Set<ToolGroupName>([...groups, ...WIDE_FALLBACK])
  const tools = assembleSelectedTools([...widened])
  return applyToolCacheControl(toolsToDefinitions(tools))
}
