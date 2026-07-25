/**
 * Universal pipeline Phase 0 — CI guardrails for the tool-selection pipeline.
 *
 * These are the invariants that, when they broke, produced the owner-visible
 * failures this program exists to kill:
 *   - a pack/diet name that no longer resolves in the registry → a tool the head
 *     is promised but never receives;
 *   - a pack over the 24 hard limit → silent truncation;
 *   - a routed turn with no find_tool → the head can only say "tool নেই";
 *   - a provider-cap trim that drops the RELEVANT tool and keeps an unrelated one.
 */
import { describe, it, expect } from 'vitest'
import {
  CORE_PACK,
  DOMAIN_PACKS,
  MARKETING_CORE_PACK,
  MARKETING_SEED_PACKS,
  HEAD_TOOL_HARD_LIMIT,
  assemblePack,
  assemblePackWithLimit,
  type PackKey,
} from '../state-router'
import { HEAD_CORE_TOOL_NAMES } from '../select-tools'
import { FIND_TOOL_NAME } from '../find-tool'
import { TOOL_GROUPS, TOOL_GROUP_NAMES } from '../tool-groups'
import { narrowToolsToCap } from '@/agent/lib/models/head-tool-cap'
import { SPECIALIST_ROLES, SPECIALIST_ROLE_KEYS } from '@/agent/lib/models/specialist-roles'

const ALL_PACK_KEYS = Object.keys(DOMAIN_PACKS) as PackKey[]

/** Every tool name reachable from ANY group (the union the selectors draw from). */
const REGISTRY_NAMES = new Set(
  TOOL_GROUP_NAMES.flatMap((g) => (TOOL_GROUPS[g] ?? []).map((t) => t.name)),
)

describe('name resolution — no selector may promise a tool that does not exist', () => {
  it('every CORE_PACK name resolves', () => {
    expect(CORE_PACK.filter((n) => !REGISTRY_NAMES.has(n))).toEqual([])
  })

  it('every DOMAIN_PACKS name resolves', () => {
    const bad: string[] = []
    for (const key of ALL_PACK_KEYS) {
      for (const n of DOMAIN_PACKS[key]) if (!REGISTRY_NAMES.has(n)) bad.push(`${key}:${n}`)
    }
    expect(bad).toEqual([])
  })

  it('every head-diet core name resolves', () => {
    expect([...HEAD_CORE_TOOL_NAMES].filter((n) => !REGISTRY_NAMES.has(n))).toEqual([])
  })

  it('every specialist role toolPacks entry is a real pack key', () => {
    const bad: string[] = []
    for (const role of SPECIALIST_ROLE_KEYS) {
      for (const p of SPECIALIST_ROLES[role].toolPacks ?? []) {
        if (!(p in DOMAIN_PACKS)) bad.push(`${role}:${p}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('find_tool is the universal escape hatch', () => {
  it('CORE_PACK carries find_tool — a routed turn can always reach the full registry', () => {
    expect([...CORE_PACK]).toContain(FIND_TOOL_NAME)
  })

  it('the marketing core keeps find_tool but drops delegation (owner rule)', () => {
    expect(MARKETING_CORE_PACK).toContain(FIND_TOOL_NAME)
    expect(MARKETING_CORE_PACK).not.toContain('delegate_to_specialist')
  })

  it('find_tool survives the trim in every pack combination', () => {
    for (const a of ALL_PACK_KEYS) {
      for (const b of ALL_PACK_KEYS) {
        expect(assemblePack([a, b]).names).toContain(FIND_TOOL_NAME)
      }
    }
    expect(assemblePack(ALL_PACK_KEYS).names).toContain(FIND_TOOL_NAME)
  })

  it('the head diet also keeps find_tool loaded', () => {
    expect(HEAD_CORE_TOOL_NAMES.has(FIND_TOOL_NAME)).toBe(true)
  })
})

describe('hard limit — no pack combination may exceed 24', () => {
  it('single packs, pairs and the all-packs worst case stay ≤ 24', () => {
    for (const key of ALL_PACK_KEYS) {
      expect(assemblePack([key]).names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
      expect(assemblePack([key]).trimmed).toEqual([])
    }
    for (const a of ALL_PACK_KEYS) {
      for (const b of ALL_PACK_KEYS) {
        expect(assemblePack([a, b]).names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
      }
    }
    expect(assemblePack(ALL_PACK_KEYS).names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
  })

  it('names are unique — a duplicate would waste a capped slot', () => {
    const { names } = assemblePack(ALL_PACK_KEYS)
    expect(new Set(names).size).toBe(names.length)
  })

  it('round-robin gives every matched pack its front tools (no starved tail pack)', () => {
    // The concatenating version spent the whole budget on the first pack:
    // erp+website dropped `publish_product`, the tool the message asked for.
    const { names } = assemblePack(['erp', 'website'])
    expect(names).toContain('get_sales_summary') // erp front
    expect(names).toContain('publish_product') // website front — used to be trimmed
  })

  it('the marketing profile always carries ads + social + creative tools', () => {
    const { names } = assemblePackWithLimit(MARKETING_SEED_PACKS, { core: MARKETING_CORE_PACK })
    expect(names).toContain('recommend_ad_actions')
    expect(names).toContain('post_to_facebook')
    expect(names).toContain('generate_image')
    expect(names).not.toContain('delegate_to_specialist')
    expect(names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
  })
})

describe('relevance-aware provider cap (Phase 4)', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}` }))

  it('an infinite cap is a pass-through', () => {
    const tools = mk(300)
    const r = narrowToolsToCap(tools, Infinity)
    expect(r.tools).toHaveLength(300)
    expect(r.trimmed).toEqual([])
  })

  it('reserves dynamic headroom so find_tool loads cannot re-breach the cap', () => {
    const r = narrowToolsToCap(mk(250), 200, { dynamicHeadroom: 8 })
    expect(r.effectiveCap).toBe(192)
    expect(r.tools).toHaveLength(192)
    expect(r.tools.length + 8).toBeLessThanOrEqual(200)
  })

  it('keeps keepNames + relevantNames even when they sit at the very end', () => {
    const tools = [...mk(200), { name: 'find_tool' }, { name: 'recommend_ad_actions' }]
    const r = narrowToolsToCap(tools, 200, {
      keepNames: ['find_tool'],
      relevantNames: ['recommend_ad_actions'],
      dynamicHeadroom: 8,
    })
    const kept = r.tools.map((t) => t.name)
    expect(kept).toContain('find_tool')
    expect(kept).toContain('recommend_ad_actions')
    expect(r.trimmed.length).toBeGreaterThan(0)
    // every dropped name is reported — a trim is never silent
    expect(kept.length + r.trimmed.length).toBe(tools.length)
  })

  it('preserves original relative order (byte-stable prefix)', () => {
    const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'keep' }]
    const r = narrowToolsToCap(tools, 3, { keepNames: ['keep'] })
    expect(r.tools.map((t) => t.name)).toEqual(['a', 'b', 'keep'])
  })
})
