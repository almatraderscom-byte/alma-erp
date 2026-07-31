/**
 * SK-4 — the enforcement layer, tested against the failures it exists for.
 */
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ALLOWED,
  dependencyBlockMessage,
  doneGateMessage,
  filterToolsForSkill,
  skillAllowlist,
  skillDependencyGaps,
  skillDoneMisses,
} from '@/agent/lib/skill-engine/enforcement'

const audit = { requiredCapabilities: ['run_website_seo_audit', 'check_website_seo_audit'] }
const tools = [
  { name: 'run_website_seo_audit' },
  { name: 'check_website_seo_audit' },
  { name: 'draft_seo_fixes' },
  { name: 'publish_product' },
  { name: 'find_tool' },
]

describe('the tool allowlist — the only enforcement that has ever held here', () => {
  it('a read-only audit skill is handed no write tool at all', () => {
    const { tools: kept, removed } = filterToolsForSkill(tools, audit)

    expect(kept.map((t) => t.name)).not.toContain('draft_seo_fixes')
    expect(kept.map((t) => t.name)).not.toContain('publish_product')
    expect(removed).toEqual(['draft_seo_fixes', 'publish_product'])
  })

  it('keeps discovery and escalation — a skill must never be trapped', () => {
    const { tools: kept } = filterToolsForSkill(tools, audit)
    expect(kept.map((t) => t.name)).toContain('find_tool')
    for (const t of ALWAYS_ALLOWED) expect(skillAllowlist(audit)!.has(t)).toBe(true)
  })

  it('an empty allowlist means "does not narrow", never "no tools"', () => {
    expect(skillAllowlist({ requiredCapabilities: [] })).toBeNull()
    const { tools: kept, removed } = filterToolsForSkill(tools, { requiredCapabilities: [] })
    expect(kept).toHaveLength(tools.length)
    expect(removed).toEqual([])
  })
})

describe('dependencies — the 15 wasted steps, prevented', () => {
  const skill = { dependencies: { env: ['WEBSITE_SUPABASE_URL', 'WEBSITE_SUPABASE_SERVICE_ROLE_KEY'] } }

  it('names exactly which half is missing', () => {
    const gaps = skillDependencyGaps(skill, {
      WEBSITE_SUPABASE_SERVICE_ROLE_KEY: 'key',
    } as unknown as NodeJS.ProcessEnv)

    expect(gaps).toEqual([{ kind: 'env', name: 'WEBSITE_SUPABASE_URL' }])
  })

  it('says nothing when everything is present', () => {
    const gaps = skillDependencyGaps(skill, {
      WEBSITE_SUPABASE_URL: 'https://x.supabase.co',
      WEBSITE_SUPABASE_SERVICE_ROLE_KEY: 'key',
    } as unknown as NodeJS.ProcessEnv)

    expect(gaps).toEqual([])
    expect(dependencyBlockMessage('seo-fixing-own-site', gaps)).toBe('')
  })

  it('tells the head to say it once and stop, not to tour the failure', () => {
    const msg = dependencyBlockMessage('seo-fixing-own-site', [{ kind: 'env', name: 'WEBSITE_SUPABASE_URL' }])
    expect(msg).toContain('WEBSITE_SUPABASE_URL')
    expect(msg).toContain('প্রথম উত্তরেই')
    expect(msg).toContain('ঘুরপথ খুঁজো না')
  })
})

describe('the done gate — "হয়ে গেছে" must be earned', () => {
  const skill = { done: [{ tool: 'audit_product_seo' }, { tool: 'draft_seo_fixes' }, { check: 'no_finding_left_open' }] }

  it('a turn that measured but never staged anything is not done', () => {
    const misses = skillDoneMisses(skill, [{ toolName: 'audit_product_seo', status: 'success' }])

    expect(misses).toEqual([
      { kind: 'tool', name: 'draft_seo_fixes' },
      { kind: 'check', name: 'no_finding_left_open' },
    ])
  })

  it('a FAILED call is not evidence', () => {
    const misses = skillDoneMisses(skill, [
      { toolName: 'audit_product_seo', status: 'success' },
      { toolName: 'draft_seo_fixes', status: 'error' },
    ])
    expect(misses.map((m) => m.name)).toContain('draft_seo_fixes')
  })

  it('passes only when every condition is genuinely met', () => {
    const misses = skillDoneMisses(
      skill,
      [
        { toolName: 'audit_product_seo', status: 'success' },
        { toolName: 'draft_seo_fixes', status: 'success' },
      ],
      ['no_finding_left_open'],
    )
    expect(misses).toEqual([])
    expect(doneGateMessage('seo-fixing-own-site', misses)).toBe('')
  })

  it('names what is left instead of scolding', () => {
    const msg = doneGateMessage('seo-fixing-own-site', [{ kind: 'tool', name: 'draft_seo_fixes' }])
    expect(msg).toContain('draft_seo_fixes')
    expect(msg).toContain('"হয়ে গেছে" বলছি না')
  })
})

describe('Mac tools survive skill isolation (live-hit 2026-08-01)', () => {
  it('a pinned skill cannot strip the owner’s Mac capabilities', () => {
    // An unrelated invoice skill got pinned on "amar mac e ekta claude session
    // kholo" and removed every Mac tool, so the head could not do the one thing
    // he asked for. These are owner-service tools like ask_user.
    const manifest = { requiredCapabilities: ['get_orders'] }
    const tools = [
      { name: 'get_orders' },
      { name: 'run_mac_command' },
      { name: 'start_cli_session' },
      { name: 'read_cli_session' },
      { name: 'mac_agent_status' },
      { name: 'get_sales_summary' },
    ]
    const { tools: kept, removed } = filterToolsForSkill(tools, manifest)
    const keptNames = kept.map((t) => t.name)
    expect(keptNames).toContain('run_mac_command')
    expect(keptNames).toContain('start_cli_session')
    expect(keptNames).toContain('read_cli_session')
    expect(keptNames).toContain('mac_agent_status')
    // Unrelated tools are still narrowed away — isolation still works.
    expect(removed).toContain('get_sales_summary')
  })
})
