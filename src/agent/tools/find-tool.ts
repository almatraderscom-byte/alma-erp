/**
 * Harness Gap 5 — model-agnostic tool discovery + dynamic load.
 *
 * The per-turn tool selection ships only a shortlist, so the head sometimes
 * cannot see a tool that DOES exist (owner hit this live 2026-07-22: head said
 * "send_whatsapp নেই" while the registry has it). The native Anthropic
 * tool-search covers only the Claude path and only the schemas already passed
 * in. `find_tool` instead searches the FULL registry for ANY head model; after
 * a find_tool round, both loop paths append the matched tools' schemas for the
 * remaining rounds of the turn (appended after the cached prefix — cache-safe).
 *
 * find_tool itself is read-only. A dynamically loaded tool still passes every
 * existing guard when called (owner-intent, controls, AIOS door, approval
 * contracts) — discovery widens visibility, never authority.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTool } from './registry'
import type { ToolGroupName } from './tool-groups'

export const FIND_TOOL_NAME = 'find_tool'

/** Max schemas one turn may dynamically load — keeps token cost bounded. */
export const MAX_DYNAMIC_TOOLS_PER_TURN = 8

export interface ToolSearchMatch {
  name: string
  description: string
  groups: ToolGroupName[]
}

/**
 * Lazy import breaks the registry → find-tool → tool-groups → registry cycle:
 * tool-groups is only loaded when a search actually runs, never at module init.
 */
async function allToolsUnique(): Promise<Map<string, { tool: AgentTool; groups: ToolGroupName[] }>> {
  const { TOOL_GROUPS, TOOL_GROUP_NAMES } = await import('./tool-groups')
  const map = new Map<string, { tool: AgentTool; groups: ToolGroupName[] }>()
  for (const group of TOOL_GROUP_NAMES) {
    for (const tool of TOOL_GROUPS[group] ?? []) {
      const entry = map.get(tool.name)
      if (entry) {
        if (!entry.groups.includes(group)) entry.groups.push(group)
      } else {
        map.set(tool.name, { tool, groups: [group] })
      }
    }
  }
  return map
}

/**
 * Keyword search over the whole registry. Deterministic scoring:
 * exact name > name substring > per-word description hits.
 */
export async function searchToolInventory(query: string, limit = 8): Promise<ToolSearchMatch[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  // Words under 3 chars ("to", "e", "ke") hit every description and drown the
  // signal — a real tool/capability keyword is always ≥3 chars.
  const words = q.split(/[\s,/]+/).filter((w) => w.length > 2)
  const scored: Array<{ score: number; match: ToolSearchMatch }> = []

  for (const { tool, groups } of (await allToolsUnique()).values()) {
    const name = tool.name.toLowerCase()
    const desc = tool.description.toLowerCase()
    let score = 0
    if (name === q) score += 100
    else if (name.includes(q) || q.includes(name)) score += 50
    for (const w of words) {
      if (name.includes(w)) score += 20
      if (desc.includes(w)) score += 5
    }
    if (score > 0) {
      scored.push({
        score,
        match: { name: tool.name, description: tool.description.slice(0, 160), groups },
      })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.match.name.localeCompare(b.match.name))
    .slice(0, limit)
    .map((s) => s.match)
}

/** Resolve full AgentTool objects (with handlers) for dynamic loading. */
export async function resolveToolsByName(names: string[]): Promise<AgentTool[]> {
  const map = await allToolsUnique()
  const out: AgentTool[] = []
  for (const name of names) {
    const entry = map.get(name)
    if (entry) out.push(entry.tool)
  }
  return out
}

/**
 * The find_tool AgentTool. The handler only SEARCHES; the calling loop reads
 * `data.matches` and appends those schemas for later rounds (it owns the live
 * tool list — the handler cannot and must not mutate it).
 */
export const find_tool: AgentTool = {
  name: FIND_TOOL_NAME,
  description:
    'Search the FULL tool registry when a capability seems missing from your current tool list. ' +
    'Returns matching tool names + descriptions, and those tools become callable in your NEXT step of this turn. ' +
    'Use this BEFORE telling the Boss a tool does not exist.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'What you are looking for — tool name fragment or capability keywords (e.g. "whatsapp send", "camera speak", "urgent alert")',
      },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const query = String(input.query ?? '').trim()
    if (!query) return { success: false, error: 'query is required' }
    const matches = await searchToolInventory(query, MAX_DYNAMIC_TOOLS_PER_TURN)
    if (matches.length === 0) {
      return {
        success: true,
        data: {
          matches: [],
          note: `"${query}" — রেজিস্ট্রিতে মেলে এমন কোনো টুল নেই। Boss-কে সৎভাবে বলো এই সক্ষমতা এখনো নেই।`,
        },
      }
    }
    return {
      success: true,
      data: {
        matches,
        note:
          'এই টুলগুলোর schema তোমার পরের ধাপ থেকে এই turn-এ available। ' +
          'sensitive টুল হলে অনুমোদন-গেট আগের মতোই প্রযোজ্য।',
      },
    }
  },
}

/** Anthropic-shape definition used by the multi-model path's adapters too. */
export function findToolDefinition(): Anthropic.Messages.Tool {
  return {
    name: find_tool.name,
    description: find_tool.description,
    input_schema: find_tool.input_schema,
  }
}
