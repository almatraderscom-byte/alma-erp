import { describe, it, expect } from 'vitest'
import { PROMPT_MODULES, compileStableCore, buildSystemPromptBlocks } from '../system-prompt'
import { TOOLS, TRADING_TOOLS, PERSONAL_SAFE_TOOLS } from '@/agent/tools/registry'
import { CUSTOMER_SAFE_TOOLS } from '@/agent/tools/cs-registry'

/**
 * Phase 6 — prompt conflict linter (roadmap §G). CI-enforced invariants:
 *  1. every snake_case tool the prompt teaches actually exists (no references
 *     to unavailable tools);
 *  2. contradictory routing notes (marketing self-serve vs slim delegation)
 *     can never co-assemble into one prompt;
 *  3. a "HARD RULE" must carry its incident date or a code-guard reference —
 *     no undated temporary patches;
 *  4. incident paragraphs whose enforcement moved into workflow guards stay
 *     REMOVED (regression locks);
 *  5. token budgets: stable core ≤5k, narrow routed turn within its ceiling.
 *
 * Token estimate: ascii chars/4 + non-ascii chars/1.7 — deliberately crude but
 * stable and conservative for Bangla (real tokenizers count Bangla cheaper),
 * so a passing gate here passes in production too.
 */

const estimateTokens = (t: string): number => {
  let ascii = 0
  let other = 0
  for (const ch of t) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.round(ascii / 4 + other / 1.7)
}

const ALL_TOOL_NAMES = new Set(
  [...TOOLS, ...TRADING_TOOLS, ...PERSONAL_SAFE_TOOLS, ...CUSTOMER_SAFE_TOOLS].map((t) => t.name),
)

// snake_case tokens in prompt prose that are NOT tool names (tables, params,
// env keys, compound Bangla-English phrases). A NEW unknown token fails CI —
// that's the "references to unavailable tools" gate; extend deliberately.
const NON_TOOL_ALLOWLIST = new Set([
  'tool_choice', 'parallel_tool_calls', 'cache_control', 'next_allowed_tools',
  'workflow_runs', 'agent_kv_settings', 'pending_actions', 'ask_user_card',
  'follow_up', 'e_g', 'i_e', 'read_dom', 'read_text', 'select_option', 'pick_option',
  'upload_file', 'scroll_to', 'go_back', 'switch_tab', 'close_tab', 'site_lockdown',
  'staff_monitor', 'x_ai', 'answer_bangla', 'formatted_bangla', 'outcome_learning',
  'live_browser', // generic tool-family prefix in prose ("live_browser tools")
  'client_seo', // skill-pack key (start_skill_pack), not a tool
  'staff_task', // workflow-template kind (Phase 5), not a tool
  // PA-2 proactive-call KV keys + pending-action type (documented for update_setting)
  'proactive_calls_enabled', 'proactive_call_stage_wait_min', 'proactive_call_daily_cap',
  'proactive_call_approval_stuck_min', 'proactive_call_urgent_stuck_min', 'urgent_notify',
  // PA-5R inbound-transfer KV key + its mode values (documented for update_setting)
  'inbound_transfer_mode', 'ask_first',
  // Browser driver values the prompt must name so the head can pass them
  // (run_browser_task `driver`): vps / vps_live / companion.
  'vps_live',
  // manage_browser_logins action values.
  'clear_cache', 'clear_site', 'clear_all',
  // The three browser kill-switches the prompt must name apart, because "live
  // browser" in Bangla means two different machines and the head has to pick one.
  'live_browser_enabled', 'browser_live_view_enabled', 'browser_agent_enabled',
])

function snakeTokens(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])]
}

describe('prompt module registry', () => {
  it('ids are unique, texts non-empty, versions dated', () => {
    const ids = PROMPT_MODULES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of PROMPT_MODULES) {
      expect(m.text.trim().length, m.id).toBeGreaterThan(0)
      expect(m.version, m.id).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/)
    }
  })

  it('never references a tool that does not exist (roadmap linter gate)', () => {
    const unknown: string[] = []
    for (const m of PROMPT_MODULES) {
      for (const tok of snakeTokens(m.text)) {
        if (!ALL_TOOL_NAMES.has(tok) && !NON_TOOL_ALLOWLIST.has(tok)) {
          unknown.push(`${m.id}: ${tok}`)
        }
      }
    }
    expect(unknown, `prompt references unknown tools/tokens:\n${unknown.join('\n')}`).toEqual([])
  })

  it('every HARD RULE carries an incident date or a code-guard reference', () => {
    const offenders: string[] = []
    for (const m of PROMPT_MODULES) {
      for (const line of m.text.split('\n')) {
        if (!/HARD RULE/i.test(line)) continue
        // Pass when the rule carries an incident date, a code-guard reference,
        // or an explicit PERMANENT marker — the roadmap gate targets undated
        // TEMPORARY patches, not standing owner law.
        const ok =
          /20\d\d/.test(line)
          || /কোডে|code-enforced|workflow guard|WORKFLOW_BLOCKED|ONE_CARD/i.test(line)
          || /HIGHEST PRIORITY|permanent|স্থায়ী/i.test(line)
        if (!ok) offenders.push(`${m.id}: ${line.slice(0, 100)}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('contradiction gates', () => {
  it('marketing self-serve and slim delegation notes NEVER co-assemble', () => {
    const marketing = buildSystemPromptBlocks({ businessId: 'ALMA_LIFESTYLE', headTier: 'marketing' })
      .stable.map((b) => b.text).join('')
    expect(marketing).toContain('do it YOURSELF directly')
    expect(marketing).not.toContain('Marketing is delegate-by-default')

    const slim = buildSystemPromptBlocks({ businessId: 'ALMA_LIFESTYLE', headTier: 'heavy' })
      .stable.map((b) => b.text).join('')
    expect(slim).toContain('Marketing is delegate-by-default')
    expect(slim).not.toContain('do it YOURSELF directly')
  })

  it('slim routing states the copy-only exception before marketing delegation', () => {
    const slim = buildSystemPromptBlocks({ businessId: 'ALMA_LIFESTYLE', headTier: 'heavy' })
      .stable.map((b) => b.text).join('')
    expect(slim).not.toContain('For ANY such task')
    expect(slim.indexOf('COPY-ONLY EXCEPTION')).toBeLessThan(slim.indexOf('Marketing is delegate-by-default'))
  })

  it('incident paragraphs replaced by workflow guards stay removed (regression locks)', () => {
    const full = buildSystemPromptBlocks({ businessId: 'ALMA_LIFESTYLE' })
      .stable.map((b) => b.text).join('')
    expect(full).not.toContain('প্রোডাক্টের ছবি = আসল ছবি (HARD RULE')
    expect(full).not.toContain('পোস্ট pipeline = তোমার নিজের কাজ (HARD RULE')
    expect(full).not.toContain('Generated ছবির preview confirm (HARD RULE')
    expect(full).not.toContain('এক কাজ = এক card (HARD RULE')
    // …and their code-guard references are present instead.
    expect(full).toContain('workflow guard')
    expect(full).toContain('ONE_CARD_AT_A_TIME')
  })
})

describe('token budgets (roadmap Phase 6 exit gates)', () => {
  it('stable core (identity + safety + style + work policy) ≤ 6k tokens', () => {
    // 5k → 6k, 2026-07-27. `working_discipline` is core on purpose: it is what
    // the agent IS, not task knowledge, so it must survive skill isolation.
    expect(estimateTokens(compileStableCore())).toBeLessThanOrEqual(6000)
  })

  it('narrow routed turn stays inside its stable-prompt ceiling', () => {
    // A state-routed continuation: base group, no browser/workbench tools —
    // the lean prompt the router-mode head sees (tools add ~3k more).
    //
    // 12,500 → 13,000 on 2026-07-27, deliberately and with the owner's decision,
    // because the measurement that forced the question is worth recording: the
    // prompt was sitting at ~12,492 tokens. EIGHT tokens of headroom. Nothing
    // could be added anywhere without removing something first, and moving text
    // to another module does not help — the narrow build includes every
    // unconditional module anyway.
    //
    // The money was never the reason to hold the line. Derived from his own
    // turn meters that day: ~$0.20 per million CACHED-read tokens, and the
    // always-on prompt is cached, so +500 tokens is about ৳৩৫/month at 100
    // turns a day. The ceiling exists because a budget with no ceiling is never
    // defended — every addition is individually tiny, and that is exactly how
    // the full prompt reached ~93k chars. This raise is a stated allowance with
    // a reason, not "enough to fit what I just wrote".
    //
    // The real fix is a trim pass on the always-on prompt. Until that happens,
    // treat the next request to raise this number as a refusal.
    //
    // 13,000 → 14,500, 2026-07-27 — and the refusal note above is MINE, so
    // overriding it needs to be said out loud rather than quietly edited. The
    // owner lifted the constraint explicitly for the harness-parity work:
    // *"Budget বা Prompt Size নিয়ে আমার কোনো আপত্তি নেই … Cost কিছুটা বাড়ে,
    // সেটাও আমার জন্য গ্রহণযোগ্য"*. Measured cost of the +1,043 tokens this
    // buys, from his own turn meters (~$0.20 per million cached-read tokens,
    // and the always-on prompt is cached): about ৳৭৫/month at 100 turns a day.
    // The note stands for anyone who has NOT been given that permission.
    const narrow = buildSystemPromptBlocks({
      businessId: 'ALMA_LIFESTYLE',
      activeGroups: ['base'],
      activeToolNames: ['get_current_datetime', 'save_memory', 'ask_user', 'post_to_facebook'],
    }).stable.map((b) => b.text).join('')
    expect(estimateTokens(narrow)).toBeLessThanOrEqual(14_500)
  })

  it('assembly is deterministic (same args → same bytes)', () => {
    const args = {
      businessId: 'ALMA_LIFESTYLE' as const,
      activeGroups: ['base', 'erp'] as import('@/agent/tools/tool-groups').ToolGroupName[],
      activeToolNames: ['get_orders', 'ask_user'],
    }
    const a = buildSystemPromptBlocks(args).stable.map((b) => b.text).join('')
    const b = buildSystemPromptBlocks(args).stable.map((b2) => b2.text).join('')
    expect(a).toBe(b)
  })
})
