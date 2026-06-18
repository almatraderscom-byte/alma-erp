import { describe, it, expect } from 'vitest'
import { selectToolGroups, selectToolGroupsSync, assembleSelectedTools } from '@/agent/tools/select-tools'
import type { ToolGroupName } from '@/agent/tools/tool-groups'

const ALMA_OPTS = { personalMode: false, businessId: 'ALMA_LIFESTYLE' as const }

type GoldenRow = {
  utterance: string
  mustIncludeGroup: ToolGroupName
  mustExposeTool: string
}

const GOLDEN_TABLE: GoldenRow[] = [
  // --- Staff ---
  { utterance: 'Eyafi ke ajke product shoot er task dao', mustIncludeGroup: 'staff', mustExposeTool: 'propose_staff_tasks' },
  { utterance: 'Mustahid er hajira check koro', mustIncludeGroup: 'staff', mustExposeTool: 'get_staff_tasks' },
  { utterance: 'staff ke dispatch koro order pack korte', mustIncludeGroup: 'staff', mustExposeTool: 'approve_and_dispatch_tasks' },
  { utterance: 'Eyafi er task status dekhao', mustIncludeGroup: 'staff', mustExposeTool: 'get_staff_tasks' },
  { utterance: 'approve koro pending staff message', mustIncludeGroup: 'staff', mustExposeTool: 'approve_pending_staff_message' },

  // --- ERP ---
  { utterance: 'ajker sales koto', mustIncludeGroup: 'erp', mustExposeTool: 'get_sales_summary' },
  { utterance: 'stock check koro panjabi gulo te', mustIncludeGroup: 'erp', mustExposeTool: 'get_inventory_status' },
  { utterance: 'last 7 day er order dekhao', mustIncludeGroup: 'erp', mustExposeTool: 'get_orders' },
  { utterance: 'product price analyze koro', mustIncludeGroup: 'erp', mustExposeTool: 'analyze_pricing' },
  { utterance: 'reorder suggestion dao', mustIncludeGroup: 'erp', mustExposeTool: 'get_reorder_suggestions' },

  // --- Salah ---
  { utterance: 'Maghrib porlam', mustIncludeGroup: 'salah', mustExposeTool: 'mark_salah' },
  { utterance: 'asr er namaz poreci', mustIncludeGroup: 'salah', mustExposeTool: 'mark_salah' },
  { utterance: 'prayer time dekhao', mustIncludeGroup: 'salah', mustExposeTool: 'get_prayer_times' },
  { utterance: 'ei week salah status dao', mustIncludeGroup: 'salah', mustExposeTool: 'get_salah_weekly_summary' },

  // --- Finance ---
  { utterance: 'last month er expense summary dao', mustIncludeGroup: 'finance', mustExposeTool: 'get_expense_summary' },
  { utterance: 'ajke 500 টাকা expense hoyeche office supplies e', mustIncludeGroup: 'finance', mustExposeTool: 'log_expense' },
  { utterance: 'ledger balance dekhao', mustIncludeGroup: 'finance', mustExposeTool: 'get_ledger_balances' },

  // --- CS ---
  { utterance: 'oi customer ke winback message pathao', mustIncludeGroup: 'cs', mustExposeTool: 'get_customer_intelligence' },
  { utterance: 'messenger inbox check koro notun message ache kina', mustIncludeGroup: 'cs', mustExposeTool: 'get_customer_intelligence' },
  { utterance: 'customer segment analysis koro subscriber base e', mustIncludeGroup: 'cs', mustExposeTool: 'get_customer_intelligence' },

  // --- Growth ---
  { utterance: 'competitor ra ki dam dicche', mustIncludeGroup: 'growth', mustExposeTool: 'research_competitor' },
  { utterance: 'ad campaign er ROAS kemon', mustIncludeGroup: 'growth', mustExposeTool: 'recommend_ad_actions' },
  { utterance: 'marketing plan banao next month er jonno', mustIncludeGroup: 'growth', mustExposeTool: 'plan_marketing' },
  { utterance: 'SEO audit koro website er', mustIncludeGroup: 'growth', mustExposeTool: 'audit_product_seo' },
  { utterance: 'competitor watchlist update koro', mustIncludeGroup: 'growth', mustExposeTool: 'manage_competitor_watchlist' },

  // --- Content ---
  { utterance: 'notun reel banao father-son panjabi', mustIncludeGroup: 'content', mustExposeTool: 'make_product_reel' },
  { utterance: 'Facebook post create koro offer niye', mustIncludeGroup: 'content', mustExposeTool: 'run_content_post' },
  { utterance: 'ad creative banao panjabi collection er jonno', mustIncludeGroup: 'content', mustExposeTool: 'make_ad_creatives' },

  // --- Diag ---
  { utterance: 'system e ki somossa hocche diagnose koro', mustIncludeGroup: 'diag', mustExposeTool: 'diagnose_issue' },
  { utterance: 'health scan chalaow', mustIncludeGroup: 'diag', mustExposeTool: 'run_health_scan' },

  // --- Website ---
  { utterance: 'website catalog check koro', mustIncludeGroup: 'website', mustExposeTool: 'get_website_catalog' },
  { utterance: 'product publish koro website e', mustIncludeGroup: 'website', mustExposeTool: 'publish_product' },

  // --- Cost (lazy group, gated out of base) ---
  { utterance: 'api credit balance dekhao', mustIncludeGroup: 'cost', mustExposeTool: 'get_api_balances' },
  { utterance: 'notun subscription add koro', mustIncludeGroup: 'cost', mustExposeTool: 'add_subscription' },

  // --- Short greeting: should NOT crash, should get base+erp ---
  { utterance: 'hi', mustIncludeGroup: 'erp', mustExposeTool: 'get_dashboard_snapshot' },
  { utterance: 'assalamu alaikum', mustIncludeGroup: 'erp', mustExposeTool: 'get_sales_summary' },

  // --- Ambiguous fallback: short non-greeting ---
  { utterance: 'dekhao', mustIncludeGroup: 'erp', mustExposeTool: 'get_sales_summary' },

  // --- Trading business ---
  // (tested separately below)
]

describe('Tool Selection — Golden Table', () => {
  for (const row of GOLDEN_TABLE) {
    it(`"${row.utterance}" → group:${row.mustIncludeGroup} + tool:${row.mustExposeTool}`, () => {
      const groups = selectToolGroups(row.utterance, ALMA_OPTS)
      expect(groups).toContain(row.mustIncludeGroup)

      const tools = assembleSelectedTools(groups)
      const toolNames = tools.map(t => t.name)
      expect(toolNames).toContain(row.mustExposeTool)
    })
  }

  it('ALMA_TRADING gets trading group', () => {
    const groups = selectToolGroups('hello', { personalMode: false, businessId: 'ALMA_TRADING' as const })
    expect(groups).toContain('trading')
  })

  it('personal mode gets personal group', () => {
    const groups = selectToolGroups('remind me to call doctor', { personalMode: true, businessId: 'ALMA_LIFESTYLE' as const })
    expect(groups).toEqual(['personal'])
  })

  it('base is always included (non-personal, non-trading)', () => {
    const groups = selectToolGroups('stock check koro', ALMA_OPTS)
    expect(groups).toContain('base')
  })

  it('ambiguous short message gets fallback groups', () => {
    const groups = selectToolGroups('hmm ok', ALMA_OPTS)
    expect(groups).toContain('erp')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Confidence signal tests — proves semantic fallback triggers for off-keyword
// ═══════════════════════════════════════════════════════════════════════════
describe('Confidence signal (selectToolGroupsSync)', () => {
  it('confident when keyword matches', () => {
    const { confident } = selectToolGroupsSync('ajker sales koto', ALMA_OPTS)
    expect(confident).toBe(true)
  })

  it('confident for short greetings', () => {
    const { confident } = selectToolGroupsSync('hi', ALMA_OPTS)
    expect(confident).toBe(true)
  })

  it('confident for personal mode', () => {
    const { confident } = selectToolGroupsSync('remind me to call doctor', { personalMode: true, businessId: 'ALMA_LIFESTYLE' as const })
    expect(confident).toBe(true)
  })

  it('NOT confident: "porer week e ki plan kora jay sobkichu miliye dekhte hobe"', () => {
    const { confident } = selectToolGroupsSync(
      'porer week e ki plan kora jay sobkichu miliye dekhte hobe',
      ALMA_OPTS,
    )
    expect(confident).toBe(false)
  })

  it('NOT confident: "manush jon ke bolo giye jisnispotro thik kore rakhte"', () => {
    const { confident } = selectToolGroupsSync(
      'manush jon ke bolo office e giye jisnispotro thik kore rakhte',
      ALMA_OPTS,
    )
    expect(confident).toBe(false)
  })

  it('NOT confident: "kichu notun idea dao jeta kore next level e niye jete pari"', () => {
    const { confident } = selectToolGroupsSync(
      'kichu notun idea dao jeta kore next level e niye jete pari',
      ALMA_OPTS,
    )
    expect(confident).toBe(false)
  })

  it('NOT confident: "gotokal theke shipment er kono update aseni kothay attke ache dekhao"', () => {
    const { confident } = selectToolGroupsSync(
      'gotokal theke shipment er kono update aseni kothay attke ache dekhao',
      ALMA_OPTS,
    )
    expect(confident).toBe(false)
  })

  it('NOT confident: "ei byapar ta nijer theke check kore amake janaow result ta ki"', () => {
    const { confident } = selectToolGroupsSync(
      'ei byapar ta nijer theke check kore amake janaow result ta ki',
      ALMA_OPTS,
    )
    expect(confident).toBe(false)
  })
})
