import type Anthropic from '@anthropic-ai/sdk'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { TOOL_GROUPS, type ToolGroupName } from '@/agent/tools/tool-groups'
import type { AgentTool } from '@/agent/tools/registry'

const AMBIGUOUS_FALLBACK: ToolGroupName[] = ['staff', 'erp', 'growth', 'content']

export function selectToolGroups(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): ToolGroupName[] {
  if (opts.personalMode) return ['personal']

  if (opts.businessId === 'ALMA_TRADING') return ['base', 'trading']

  const g = new Set<ToolGroupName>(['base'])
  const t = text.trim()

  if (/staff|হাজিরা|টাস্ক|বেতন|fine|eyafi|mustahid|dispatch|approve|পাঠাও/i.test(t)) {
    g.add('staff')
    g.add('finance')
  }
  if (/order|stock|inventory|product|দাম|price|reorder|catalog/i.test(t)) g.add('erp')
  if (/customer|messenger|cs|winback|segment|inbox/i.test(t)) g.add('cs')
  if (/ad|বুস্ট|campaign|seo|competitor|গ্রো|marketing|intel|optimizer|ROAS|scale/i.test(t)) g.add('growth')
  if (/content|ছবি|image|post|model|try.?on|ব্র্যান্ড|facebook|fb|creative|অফার|offer|poster/i.test(t)) g.add('content')
  if (/website|almatraders|publish|catalog/i.test(t)) g.add('website')
  if (/salah|নামাজ|prayer|namaz|fajr|dhuhr|asr|maghrib|isha|ফজর|যোহর|আসর|মাগরিব|ইশা|জুম্মা|poreci|porlam|পড়েছি|পড়লাম|নামায/i.test(t)) g.add('salah')
  if (/expense|ledger|finance|খরচ|টাকা|bdt|aed/i.test(t)) g.add('finance')
  if (/সমস্যা|error|bug|diagnose|health|watchdog/i.test(t)) g.add('diag')

  if (g.size === 1) {
    for (const x of AMBIGUOUS_FALLBACK) g.add(x)
  }

  return [...g]
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

export function selectToolsForTurn(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Anthropic.Messages.Tool[] {
  const groups = selectToolGroups(text, opts)
  const tools = assembleSelectedTools(groups)
  return applyToolCacheControl(toolsToDefinitions(tools))
}
