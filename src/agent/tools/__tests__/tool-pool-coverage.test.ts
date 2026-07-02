import { describe, it, expect } from 'vitest'
import { TOOLS } from '../registry'
import { TOOL_GROUPS, type ToolGroupName } from '../tool-groups'

/**
 * Guard for the recurring "advertised but not executable" footgun: a tool wired
 * into a TOOL_GROUPS group is shown to the head/workers, but if it's missing
 * from the TOOLS execution pool in registry.ts, calling it returns
 * "Unknown tool" at runtime (bit get_ga4_report in production, and the
 * place_agent_call / GROWTH_TOOLS comments in registry.ts warn about exactly
 * this). Trading/personal run against their own pools, so only the
 * ALMA_LIFESTYLE owner-chat groups are asserted here.
 */
const OWNER_CHAT_GROUPS: ToolGroupName[] = [
  'base',
  'erp',
  'staff',
  'finance',
  'cs',
  'content',
  'growth',
  'website',
  'salah',
  'diag',
  'vision',
  'cost',
]

describe('TOOL_GROUPS ⊆ TOOLS execution pool', () => {
  const executable = new Set(TOOLS.map((t) => t.name))

  for (const group of OWNER_CHAT_GROUPS) {
    it(`every '${group}' group tool is executable`, () => {
      const missing = (TOOL_GROUPS[group] ?? [])
        .map((t) => t.name)
        .filter((name) => !executable.has(name))
      expect(missing).toEqual([])
    })
  }
})
