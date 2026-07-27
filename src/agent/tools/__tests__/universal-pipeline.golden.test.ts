/**
 * Universal pipeline — the HEADLINE guarantee, as a test.
 *
 * "Model choice changes WHO thinks, never WHICH tools exist."
 * The same owner question must produce the same server-selected tool set on
 * every head tier. Before this program the answer depended on the model:
 * Grok silently lost the 201st tool to xAI's cap, a pinned head fell to a slim
 * profile and truthfully said "ads tool nai", and the marketing head bypassed
 * the router entirely with ~150 schemas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: { findMany: async () => [] },
    agentPlan: { findMany: async () => [] },
    workflowRun: { findMany: async () => [] },
    agentMessage: { findMany: async () => [] },
    agentAskCard: { findMany: async () => [] },
  },
}))

import {
  selectStateRoutedTools,
  HEAD_TOOL_HARD_LIMIT,
  MARKETING_SEED_PACKS,
  DOMAIN_PACKS,
} from '../state-router'
import { FIND_TOOL_NAME } from '../find-tool'
import type { HeadTier } from '@/agent/lib/models/head-router'

// Every tier that reaches the owner head. 'personal' is deliberately excluded:
// listen-mode turns carry no business tools by design.
const NON_MARKETING_TIERS: HeadTier[] = ['heavy', 'light', 'explicit']

const QUERIES = [
  'গত ৭ দিনের অ্যাড পারফরম্যান্স — খরচ, impressions, CTR',
  'আজকের বিক্রি কত হলো?',
  '৫০০ টাকা খরচ লিখে রাখো রিকশা ভাড়া',
  'Mustahid কে stock check এর task পাঠাও',
  'almatraders এ প্রোডাক্টটা publish করো',
  'একটা ঈদ অফারের পোস্টার ছবি বানাও',
]

async function route(text: string, headTier: HeadTier) {
  return selectStateRoutedTools({
    conversationId: 'conv-universal-pipeline',
    text,
    businessId: 'ALMA_LIFESTYLE',
    personalMode: false,
    headTier,
  })
}

beforeEach(() => {
  vi.stubEnv('AGENT_UNIVERSAL_TOOL_PIPELINE', 'on')
})

describe('model-agnosticism: the same query yields the same tools on every head tier', () => {
  for (const q of QUERIES) {
    it(`"${q.slice(0, 40)}…" is identical across heavy / light / explicit`, async () => {
      const results = await Promise.all(NON_MARKETING_TIERS.map((t) => route(q, t)))
      for (const r of results) expect(r).not.toBeNull()
      const nameLists = results.map((r) => r!.tools.map((t) => t.name))
      for (const list of nameLists) expect(list).toEqual(nameLists[0])
      const packLists = results.map((r) => r!.packs.join('+'))
      for (const p of packLists) expect(p).toBe(packLists[0])
    })
  }
})

describe('every routed turn is lean and never capability-starved', () => {
  for (const q of QUERIES) {
    it(`"${q.slice(0, 40)}…" ships ≤24 tools and always carries find_tool`, async () => {
      for (const tier of [...NON_MARKETING_TIERS, 'marketing' as HeadTier]) {
        const r = await route(q, tier)
        expect(r).not.toBeNull()
        expect(r!.tools.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
        expect(r!.tools.map((t) => t.name)).toContain(FIND_TOOL_NAME)
      }
    })
  }
})

describe('the ads-performance question (the live "ads tool nai" incident)', () => {
  const ADS_Q = 'গত ৭ দিনের অ্যাড পারফরম্যান্স — খরচ, impressions, CTR'

  it('routes to the ads pack and ships recommend_ad_actions on EVERY tier', async () => {
    for (const tier of [...NON_MARKETING_TIERS, 'marketing' as HeadTier]) {
      const r = await route(ADS_Q, tier)
      expect(r!.packs).toContain('ads')
      expect(r!.tools.map((t) => t.name)).toContain('recommend_ad_actions')
    }
  })

  it('does NOT fall to a finance-only answer (the 2026-07-17 CTR miss)', async () => {
    const r = await route(ADS_Q, 'heavy')
    const names = r!.tools.map((t) => t.name)
    expect(names).not.toContain('get_financial_health')
  })
})

describe('the marketing head is a deliberate, documented divergence', () => {
  it('carries ads + social + creative tools whatever the message says', async () => {
    // A message with NO marketing keyword at all still gets the marketing packs.
    const r = await route('আজকের বিক্রি কত হলো?', 'marketing')
    expect(r).not.toBeNull()
    for (const p of MARKETING_SEED_PACKS) expect(r!.packs).toContain(p)
    const names = r!.tools.map((t) => t.name)
    const anyAds = DOMAIN_PACKS.ads.some((n) => names.includes(n))
    expect(anyAds).toBe(true)
  })

  it('never carries delegate_to_specialist (owner rule: Qwen does marketing itself)', async () => {
    for (const q of QUERIES) {
      const r = await route(q, 'marketing')
      expect(r!.tools.map((t) => t.name)).not.toContain('delegate_to_specialist')
    }
  })

  it('keeps its legacy full-marketing profile when the flag is off', async () => {
    vi.stubEnv('AGENT_UNIVERSAL_TOOL_PIPELINE', 'off')
    vi.resetModules()
    const { selectStateRoutedTools: fresh } = await import('../state-router')
    const r = await fresh({
      conversationId: 'conv-universal-pipeline',
      text: 'ঈদের ক্যাম্পেইন বানাও',
      businessId: 'ALMA_LIFESTYLE',
      personalMode: false,
      headTier: 'marketing',
    })
    expect(r).toBeNull() // → caller falls back to select-tools' mkGroups
  })
})

describe('non-marketing tiers still carry delegation (the note must be true)', () => {
  it('delegate_to_specialist is shipped on every non-marketing tier', async () => {
    for (const tier of NON_MARKETING_TIERS) {
      const r = await route('আজকের বিক্রি কত হলো?', tier)
      expect(r!.tools.map((t) => t.name)).toContain('delegate_to_specialist')
    }
  })
})
