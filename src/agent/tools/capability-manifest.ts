/**
 * Capability manifest (Phase 2) — the joined, resolved view of every executable
 * agent tool: identity + strict input schema (from the registries) + authored
 * classification (capability-classification.ts) + routing reality (pools it can
 * execute in, TOOL_GROUPS that advertise it).
 *
 * Consumers:
 *   - capability-manifest.test.ts — generated coverage: classification complete,
 *     schemas compile, exposed⊆executable, executable⇒routable.
 *   - Phase 3 router — domain packs + head-exposure decisions come from here.
 *   - Dashboards — telemetry labels (domain/mode/risk) match these values.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  TOOLS,
  TRADING_TOOLS,
  PERSONAL_SAFE_TOOLS,
  STAFF_SAFE_TOOLS,
  type AgentTool,
} from './registry'
import { CUSTOMER_SAFE_TOOLS } from './cs-registry'
import { TOOL_GROUPS, type ToolGroupName } from './tool-groups'
import { TOOL_CLASSIFICATION } from './capability-classification'
import { resolveClassification, type ResolvedClassification } from './tool-contract'

export type CapabilityPool = 'lifestyle' | 'trading' | 'personal' | 'staff' | 'customer'

export interface Capability extends ResolvedClassification {
  name: string
  description: string
  inputSchema: Anthropic.Messages.Tool['input_schema']
  /** Execution pools this tool is registered in. */
  pools: CapabilityPool[]
  /** TOOL_GROUPS entries that advertise this tool to a head. */
  groups: ToolGroupName[]
}

const POOL_SOURCES: Array<[CapabilityPool, AgentTool[]]> = [
  ['lifestyle', TOOLS],
  ['trading', TRADING_TOOLS],
  ['personal', PERSONAL_SAFE_TOOLS],
  ['staff', STAFF_SAFE_TOOLS],
  ['customer', CUSTOMER_SAFE_TOOLS],
]

function buildManifest(): Map<string, Capability> {
  const byName = new Map<string, Capability>()

  for (const [pool, tools] of POOL_SOURCES) {
    for (const t of tools) {
      const existing = byName.get(t.name)
      if (existing) {
        if (!existing.pools.includes(pool)) existing.pools.push(pool)
        continue
      }
      const authored = TOOL_CLASSIFICATION[t.name]
      const resolved = resolveClassification(
        authored ?? { domain: 'unclassified', mode: 'write', risk: 'medium' },
      )
      byName.set(t.name, {
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        pools: [pool],
        groups: [],
        ...resolved,
      })
    }
  }

  for (const [group, tools] of Object.entries(TOOL_GROUPS) as Array<[ToolGroupName, AgentTool[]]>) {
    for (const t of tools) {
      const cap = byName.get(t.name)
      if (cap && !cap.groups.includes(group)) cap.groups.push(group)
    }
  }

  return byName
}

const manifest = buildManifest()

/** Every executable tool, joined with classification + routing. */
export const CAPABILITIES: readonly Capability[] = [...manifest.values()]

export function getCapability(name: string): Capability | undefined {
  return manifest.get(name)
}

/** Tool names present in TOOL_GROUPS but not executable in any pool (must be empty). */
export function exposedButUnexecutable(): string[] {
  const executable = new Set(manifest.keys())
  const missing = new Set<string>()
  for (const tools of Object.values(TOOL_GROUPS)) {
    for (const t of tools) if (!executable.has(t.name)) missing.add(t.name)
  }
  return [...missing]
}

/**
 * Executable tools a head can never reach: not in any TOOL_GROUP and not
 * declared as a dedicated-surface tool (routing 'mcp' / 'customer').
 * Must be empty.
 */
export function executableButUnroutable(): string[] {
  return CAPABILITIES.filter((c) => c.groups.length === 0 && c.routing === 'group').map((c) => c.name)
}

/**
 * Phase 3 parallel-call policy: a head request may allow parallel tool calls
 * ONLY when every tool in the pack is a pure read (roadmap §D — never
 * parallelize confirm cards, writes, browser actions or dependent steps).
 * Unknown names fail closed (sequential).
 */
export function packAllowsParallelToolCalls(toolNames: readonly string[]): boolean {
  return toolNames.every((n) => getCapability(n)?.mode === 'read')
}

/** Classification entries that no longer match any executable tool (must be empty). */
export function orphanClassificationEntries(): string[] {
  return Object.keys(TOOL_CLASSIFICATION).filter((name) => !manifest.has(name))
}

/** Executable tools with no authored classification entry (must be empty). */
export function unclassifiedTools(): string[] {
  return CAPABILITIES.filter((c) => !(c.name in TOOL_CLASSIFICATION)).map((c) => c.name)
}
