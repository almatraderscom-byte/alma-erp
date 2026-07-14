import { describe, it, expect } from 'vitest'
import {
  CORE_PACK,
  DOMAIN_PACKS,
  HEAD_TOOL_HARD_LIMIT,
  assemblePack,
  isContinuationText,
  matchIntentPacks,
  packsForCheckpointTaskType,
  packsForPendingActionType,
  type PackKey,
} from '../state-router'
import { getCapability, packAllowsParallelToolCalls } from '../capability-manifest'
import { TOOLS } from '../registry'

const ALL_PACK_KEYS = Object.keys(DOMAIN_PACKS) as PackKey[]

describe('state router pack integrity (generated from the capability manifest)', () => {
  const executable = new Set(TOOLS.map((t) => t.name))

  it('every pack tool exists, is executable in the owner pool, and is head-routable', () => {
    const bad: string[] = []
    for (const name of CORE_PACK) {
      const cap = getCapability(name)
      if (!cap || !executable.has(name) || cap.routing !== 'group') bad.push(`core:${name}`)
    }
    for (const key of ALL_PACK_KEYS) {
      for (const name of DOMAIN_PACKS[key]) {
        const cap = getCapability(name)
        if (!cap || !executable.has(name) || cap.routing !== 'group') bad.push(`${key}:${name}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no single pack + core exceeds the 24-tool hard limit', () => {
    const over: string[] = []
    for (const key of ALL_PACK_KEYS) {
      const { names, trimmed } = assemblePack([key])
      if (names.length > HEAD_TOOL_HARD_LIMIT || trimmed.length > 0) {
        over.push(`${key}: ${names.length}+${trimmed.length}`)
      }
    }
    expect(over).toEqual([])
  })
})

describe('24-tool hard cap (Phase 3 exit gate: max ≤ 24, CI-enforced)', () => {
  it('ANY pack combination never yields more than 24 tools', () => {
    // worst case: all packs at once
    const { names } = assemblePack(ALL_PACK_KEYS)
    expect(names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
    // pairwise combos keep the invariant too
    for (const a of ALL_PACK_KEYS) {
      for (const b of ALL_PACK_KEYS) {
        expect(assemblePack([a, b]).names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
      }
    }
  })

  it('core pack survives trimming (priority order: core → state → intent)', () => {
    const { names } = assemblePack(ALL_PACK_KEYS)
    for (const core of CORE_PACK) expect(names).toContain(core)
  })
})

// ── Golden routing cases (Phase 3 exit gate: recall on the replay-style suite) ─

const GOLDEN: Array<{ text: string; expectPack: PackKey; expectTool: string }> = [
  { text: 'আজ ফজর পড়েছি', expectPack: 'salah', expectTool: 'mark_salah' },
  { text: 'নামাজের সময় কখন?', expectPack: 'salah', expectTool: 'get_prayer_times' },
  { text: '৫০০ টাকা খরচ লিখে রাখো রিকশা ভাড়া', expectPack: 'finance', expectTool: 'log_expense' },
  { text: 'আজকের বিক্রি কত হলো?', expectPack: 'erp', expectTool: 'get_sales_summary' },
  { text: 'stock কেমন আছে দেখাও', expectPack: 'erp', expectTool: 'get_inventory_status' },
  { text: 'Mustahid কে stock check এর task পাঠাও', expectPack: 'staff_dispatch', expectTool: 'add_staff_task_now' },
  { text: 'স্টাফদের হাজিরা দেখাও', expectPack: 'staff_read', expectTool: 'get_attendance' },
  { text: 'FB পেজে নতুন পোস্ট দাও ৭২০ কোডের', expectPack: 'social', expectTool: 'post_to_facebook' },
  { text: 'messenger inbox এ কী মেসেজ আছে?', expectPack: 'social', expectTool: 'get_fb_messenger_inbox' },
  { text: 'ক্যাম্পেইনের ROAS কেমন, budget বাড়াবো?', expectPack: 'ads', expectTool: 'recommend_ad_actions' },
  { text: 'browser দিয়ে সাইটটা খুলে দেখো', expectPack: 'browser', expectTool: 'live_browser_look' },
  { text: 'almatraders এ প্রোডাক্টটা publish করো', expectPack: 'website', expectTool: 'publish_product' },
  { text: 'SEO র‍্যাংক কেমন যাচ্ছে keyword গুলোর?', expectPack: 'seo', expectTool: 'list_tracked_keywords' },
  { text: 'একটা ঈদ অফারের পোস্টার ছবি বানাও', expectPack: 'creative', expectTool: 'generate_image' },
  { text: 'কাল সকাল ৯টায় remind করো ব্যাংকে যেতে', expectPack: 'reminders', expectTool: 'set_reminder' },
  { text: 'আম্মুকে কল করে বলো ওষুধ খেতে', expectPack: 'reminders', expectTool: 'place_agent_call' },
  { text: 'agent এ কী সমস্যা হচ্ছে diagnose করো', expectPack: 'diag', expectTool: 'diagnose_issue' },
  { text: 'API credit balance কত আছে?', expectPack: 'cost', expectTool: 'get_api_balances' },
  { text: 'এই রসিদটা পড়ে খরচ বের করো', expectPack: 'vision', expectTool: 'extract_invoice' },
  { text: 'আমার todo list দেখাও', expectPack: 'todo', expectTool: 'list_owner_todos' },
  { text: 'competitor দের panjabi র দাম research করো', expectPack: 'research', expectTool: 'research_competitor' },
  { text: 'অফিসের ক্যামেরা দেখাও কে আছে', expectPack: 'camera', expectTool: 'get_office_camera_snapshot' },
]

describe('golden intent routing (recall gate)', () => {
  for (const g of GOLDEN) {
    it(`"${g.text}" → ${g.expectPack} (${g.expectTool})`, () => {
      const packs = matchIntentPacks(g.text)
      expect(packs).toContain(g.expectPack)
      const { names } = assemblePack(packs)
      expect(names).toContain(g.expectTool)
      expect(names.length).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
    })
  }

  it('p95 exposed tools across the golden suite ≤ 24, and typical packs stay lean', () => {
    const counts = GOLDEN.map((g) => assemblePack(matchIntentPacks(g.text)).names.length).sort((a, b) => a - b)
    const p95 = counts[Math.floor(counts.length * 0.95)]
    const median = counts[Math.floor(counts.length / 2)]
    expect(p95).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
    expect(median).toBeLessThanOrEqual(24)
  })
})

describe('structured state precedes text (roadmap §C)', () => {
  it('continuation replies carry no domain of their own', () => {
    for (const t of ['হ্যাঁ', 'ok', 'ঠিক আছে', 'continue', 'চালিয়ে যাও', 'হুম', 'না']) {
      expect(isContinuationText(t)).toBe(true)
    }
    for (const t of ['আজকের অর্ডার কয়টা?', 'নতুন পোস্ট দাও', 'হ্যাঁ, আর সাথে stock ও দেখাও']) {
      expect(isContinuationText(t)).toBe(false)
    }
  })

  it('pending-action types resolve to the acting pack', () => {
    expect(packsForPendingActionType('fb_post')).toContain('social')
    expect(packsForPendingActionType('image_gen')).toContain('creative')
    expect(packsForPendingActionType('dispatch_staff_tasks')).toContain('staff_dispatch')
    expect(packsForPendingActionType('workbench_run')).toContain('workbench')
    expect(packsForPendingActionType('launch_campaign_x')).toContain('ads')
  })

  it('checkpoint task types resolve to the resuming pack', () => {
    expect(packsForCheckpointTaskType('browser')).toContain('browser')
    expect(packsForCheckpointTaskType('plan')).toContain('plan')
    expect(packsForCheckpointTaskType('image_gen')).toContain('creative')
    expect(packsForCheckpointTaskType('')).toContain('plan') // unknown → resume via plan/core
  })
})

describe('parallel-call policy (Phase 3 §D)', () => {
  it('all-read packs may parallelize; anything with stage/write may not', () => {
    expect(packAllowsParallelToolCalls(['get_sales_summary', 'get_orders', 'get_product'])).toBe(true)
    expect(packAllowsParallelToolCalls(['get_sales_summary', 'post_to_facebook'])).toBe(false)
    expect(packAllowsParallelToolCalls(['save_memory'])).toBe(false)
    expect(packAllowsParallelToolCalls(['no_such_tool'])).toBe(false) // unknown fails closed
  })

  it('every state-routed pack is sequential today (core carries writes) — documented invariant', () => {
    const { names } = assemblePack(['erp'])
    expect(packAllowsParallelToolCalls(names)).toBe(false)
  })
})
