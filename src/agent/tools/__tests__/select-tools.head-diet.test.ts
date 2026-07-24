/**
 * Head Tool Diet (cost audit Phase 2) — zero-capability-loss invariants.
 *
 * The diet shrinks the owner head's static schema pack to a curated core; the
 * long tail loads on demand via find_tool. These tests pin the guarantees:
 *   1. every curated core name really exists in the registry (a typo here would
 *      silently drop a tool from the head);
 *   2. the dieted pack is small, byte-stable, and always carries the machinery
 *      tools (find_tool, ask_user, delegate_to_specialist);
 *   3. every tool dropped by the diet is DISCOVERABLE via find_tool's registry
 *      search by its exact name — routed, never removed;
 *   4. the marketing head keeps its full specialist set (owner decision);
 *      personal / trading modes are untouched.
 */
import { describe, it, expect } from 'vitest'
import {
  selectToolsAndGroupsForTurnAsync,
  assembleSelectedTools,
  HEAD_CORE_TOOL_NAMES,
} from '@/agent/tools/select-tools'
import { searchToolInventory } from '@/agent/tools/find-tool'
import { TOOL_GROUPS, TOOL_GROUP_NAMES } from '@/agent/tools/tool-groups'

const ALMA = { personalMode: false, businessId: 'ALMA_LIFESTYLE' as const }

function allRegistryNames(): Set<string> {
  const names = new Set<string>()
  for (const g of TOOL_GROUP_NAMES) for (const t of TOOL_GROUPS[g] ?? []) names.add(t.name)
  return names
}

describe('Head Tool Diet — zero capability loss', () => {
  it('every curated core tool name exists in the registry (no silent typos)', () => {
    const registry = allRegistryNames()
    const missing = [...HEAD_CORE_TOOL_NAMES].filter((n) => !registry.has(n))
    expect(missing).toEqual([])
  })

  it('dieted owner pack is small, stable, and carries the machinery tools', async () => {
    const a = await selectToolsAndGroupsForTurnAsync('ajker sales koto', ALMA)
    const b = await selectToolsAndGroupsForTurnAsync('ajker sales koto', ALMA)
    const names = a.tools.map((t) => t.name)
    // Small: the whole point — was ~201 schemas before the diet.
    expect(names.length).toBeLessThanOrEqual(HEAD_CORE_TOOL_NAMES.size)
    expect(names.length).toBeGreaterThan(40)
    // Byte-stable across identical turns (prefix-cache requirement).
    expect(a.tools.map((t) => t.name)).toEqual(b.tools.map((t) => t.name))
    // Machinery must always ride.
    for (const must of ['find_tool', 'ask_user', 'delegate_to_specialist', 'get_sales_summary', 'mark_salah', 'log_expense']) {
      expect(names).toContain(must)
    }
    // Long-tail examples must NOT ride the static pack.
    for (const dropped of ['run_browser_task', 'list_playbook', 'save_artifact', 'get_gbp_reviews']) {
      expect(names).not.toContain(dropped)
    }
  })

  it('every dieted-out tool is discoverable via find_tool by exact name', async () => {
    // The full owner surface the diet filters from: the stable groups + growth
    // keeps. Every name NOT in the core must surface as a find_tool exact match.
    const ownerSurface = assembleSelectedTools([
      'base', 'erp', 'staff', 'finance', 'cs', 'website', 'diag', 'vision', 'cost', 'growth', 'content',
    ])
    const droppedNames = ownerSurface.map((t) => t.name).filter((n) => !HEAD_CORE_TOOL_NAMES.has(n))
    expect(droppedNames.length).toBeGreaterThan(50) // sanity: diet actually drops a long tail
    for (const name of droppedNames) {
      const matches = await searchToolInventory(name, 8)
      expect(matches.map((m) => m.name), `find_tool cannot surface "${name}"`).toContain(name)
    }
  })

  it('marketing head keeps its full specialist set (unaffected by the diet)', async () => {
    const mk = await selectToolsAndGroupsForTurnAsync('notun poster banao', { ...ALMA, headTier: 'marketing' })
    const names = mk.tools.map((t) => t.name)
    for (const must of ['post_to_facebook', 'make_ad_creatives', 'run_content_post']) {
      expect(names).toContain(must)
    }
    expect(names.length).toBeGreaterThan(HEAD_CORE_TOOL_NAMES.size)
  })

  it('personal and trading modes are untouched', async () => {
    const personal = await selectToolsAndGroupsForTurnAsync('bill list dekhao', { personalMode: true, businessId: 'ALMA_LIFESTYLE' })
    expect(personal.groups).toEqual(['personal'])
    const trading = await selectToolsAndGroupsForTurnAsync('hello', { personalMode: false, businessId: 'ALMA_TRADING' })
    expect(trading.groups).toContain('trading')
  })
})
