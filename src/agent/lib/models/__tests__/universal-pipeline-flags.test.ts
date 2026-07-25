/**
 * Universal pipeline — rollout ladder + the pieces that are pure enough to test
 * directly (sub-agent trim, delegation-note truth, head cost tier).
 *
 * Every flag must fail BACK to the exact behaviour that shipped before it: the
 * owner's kill switch has to be a real kill switch, not a hope.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  promptToolTruthEnabled,
  relevanceCapEnabled,
  toolMembershipGateMode,
  openAiSchemaSanitizeEnabled,
  universalToolPipelineEnabled,
  subagentToolTrimEnabled,
  SUBAGENT_TOOL_CAP,
} from '@/agent/config'
import { resolveHeadCostTier } from '@/agent/lib/models/registry'
import { assembleRoleTools } from '@/agent/lib/models/subagent'
import { SPECIALIST_ROLES, SPECIALIST_ROLE_KEYS } from '@/agent/lib/models/specialist-roles'
import { assembleSelectedTools } from '@/agent/tools/select-tools'
import { FIND_TOOL_NAME } from '@/agent/tools/find-tool'
import { buildSystemPromptBlocks } from '@/agent/lib/system-prompt'

afterEach(() => vi.unstubAllEnvs())

describe('rollout ladder — defaults and kill switches', () => {
  it('correctness fixes are ON by default and off-switchable', () => {
    expect(promptToolTruthEnabled(undefined)).toBe(true)
    expect(promptToolTruthEnabled('off')).toBe(false)
    expect(relevanceCapEnabled(undefined)).toBe(true)
    expect(relevanceCapEnabled('off')).toBe(false)
  })

  it('the membership gate enforces on preview, shadows in production, and obeys explicit flags', () => {
    expect(toolMembershipGateMode(undefined, 'preview')).toBe('on')
    expect(toolMembershipGateMode(undefined, 'production')).toBe('shadow')
    expect(toolMembershipGateMode('on', 'production')).toBe('on')
    expect(toolMembershipGateMode('off', 'preview')).toBe('off')
    expect(toolMembershipGateMode('shadow', 'preview')).toBe('shadow')
  })

  it('behaviour-changing phases are preview-on / production-off until the owner opts in', () => {
    for (const fn of [openAiSchemaSanitizeEnabled, universalToolPipelineEnabled, subagentToolTrimEnabled]) {
      expect(fn(undefined, 'production')).toBe(false)
      expect(fn(undefined, 'preview')).toBe(true)
      expect(fn('on', 'production')).toBe(true)
      expect(fn('off', 'preview')).toBe(false)
    }
  })
})

describe('head cost tier (Phase 6) — a budget by principle, not by vendor', () => {
  it('derives premium for Anthropic and standard for everyone else', () => {
    expect(resolveHeadCostTier({ provider: 'anthropic' })).toBe('premium')
    expect(resolveHeadCostTier({ provider: 'xai' })).toBe('standard')
    expect(resolveHeadCostTier({ provider: 'openrouter' })).toBe('standard')
    expect(resolveHeadCostTier({ provider: 'google' })).toBe('standard')
  })

  it('an explicit registry costTier wins (the field is the tuning knob)', () => {
    expect(resolveHeadCostTier({ provider: 'openrouter', costTier: 'premium' })).toBe('premium')
    expect(resolveHeadCostTier({ provider: 'anthropic', costTier: 'standard' })).toBe('standard')
  })
})

describe('specialist sub-agent trim (Phase 7)', () => {
  it('flag OFF → byte-identical legacy whole-group assembly', () => {
    vi.stubEnv('AGENT_SUBAGENT_TOOL_TRIM', 'off')
    for (const role of SPECIALIST_ROLE_KEYS) {
      const def = SPECIALIST_ROLES[role]
      const legacy = assembleSelectedTools(def.toolGroups)
        .filter((t) => t.name !== 'delegate_to_specialist')
        .map((t) => t.name)
      expect(assembleRoleTools(def).map((t) => t.name)).toEqual(legacy)
    }
  })

  it('flag ON → every role fits the cap, keeps find_tool, and drops delegation', () => {
    vi.stubEnv('AGENT_SUBAGENT_TOOL_TRIM', 'on')
    for (const role of SPECIALIST_ROLE_KEYS) {
      const tools = assembleRoleTools(SPECIALIST_ROLES[role])
      const names = tools.map((t) => t.name)
      expect(names.length).toBeLessThanOrEqual(SUBAGENT_TOOL_CAP)
      expect(names).toContain(FIND_TOOL_NAME)
      expect(names).not.toContain('delegate_to_specialist')
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('flag ON → a real cut, and each role still holds its own domain tools', () => {
    vi.stubEnv('AGENT_SUBAGENT_TOOL_TRIM', 'off')
    const before = Object.fromEntries(
      SPECIALIST_ROLE_KEYS.map((r) => [r, assembleRoleTools(SPECIALIST_ROLES[r]).length]),
    )
    vi.stubEnv('AGENT_SUBAGENT_TOOL_TRIM', 'on')
    for (const role of SPECIALIST_ROLE_KEYS) {
      expect(assembleRoleTools(SPECIALIST_ROLES[role]).length).toBeLessThan(before[role])
    }
    const named = (role: (typeof SPECIALIST_ROLE_KEYS)[number]) =>
      assembleRoleTools(SPECIALIST_ROLES[role]).map((t) => t.name)
    expect(named('analyst')).toContain('get_sales_summary')
    expect(named('analyst')).toContain('log_expense')
    expect(named('ops')).toContain('get_staff_tasks')
    expect(named('seo')).toContain('audit_product_seo')
    expect(named('cs')).toContain('get_fb_messenger_inbox')
    expect(named('marketer')).toContain('recommend_ad_actions')
    expect(named('content')).toContain('generate_image')
    expect(named('researcher')).toContain('web_research')
  })
})

describe('the delegation note only ships when delegation is actually shipped (Phase 6)', () => {
  const base = {
    projectInstructions: '',
    pinnedMemories: [],
    relevantMemories: [],
    recalledTurns: [],
    personalMode: false,
    businessId: 'ALMA_LIFESTYLE' as const,
  }
  const systemText = (activeToolNames?: string[]) =>
    buildSystemPromptBlocks({ ...base, activeToolNames })
      .stable.map((b) => b.text)
      .join('\n')

  // A phrase unique to SLIM_ROUTER_DELEGATION_NOTE (the bare tool NAME appears in
  // several other modules, so matching on it would prove nothing).
  const NOTE_MARKER = '## Routing (slim mode)'

  it('ships the note when delegate_to_specialist is in the turn tool list', () => {
    expect(systemText(['get_orders', 'delegate_to_specialist'])).toContain(NOTE_MARKER)
  })

  it('withholds it when the turn carries no delegate tool (a pinned/marketing-style pack)', () => {
    expect(systemText(['get_orders', 'recommend_ad_actions'])).not.toContain(NOTE_MARKER)
  })

  it('unknown tool list (legacy callers) keeps the old unconditional note', () => {
    expect(systemText(undefined)).toContain(NOTE_MARKER)
  })
})
