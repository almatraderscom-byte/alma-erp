import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONTROLS } from '@/agent/lib/agent-controls'
import {
  EXPLICIT_CHROME_MODALITY_TOOLS,
  hasExplicitChromeModality,
} from '@/agent/lib/live-browser/modality'
import { resolveToolsByName } from '@/agent/tools/find-tool'
import {
  composeTurnToolAllowlist,
  filterFindToolResultForTurn,
  filterTurnToolDefinitions,
  prepareFindToolResultForTurn,
  semanticFallbackToolDefinitions,
  shortlistAvailableToolDefinitions,
} from '@/agent/tools/selection/turn-capability-context'

const INCIDENT = 'Amr chrome e dhuke amr website er seo shob gulo page er deeply check koro. Amk report daw'

describe('turn capability composition', () => {
  it('keeps the SEO skill primary and overlays only the explicit Chrome modality', () => {
    const seoSkillAllowlist = new Set([
      'find_tool',
      'run_website_seo_audit',
      'check_website_seo_audit',
      'fetch_website_page',
    ])
    const composed = composeTurnToolAllowlist(seoSkillAllowlist, true)!

    expect(composed.has('run_website_seo_audit')).toBe(true)
    for (const name of EXPLICIT_CHROME_MODALITY_TOOLS) expect(composed.has(name)).toBe(true)
    expect(composed.has('draft_seo_fixes')).toBe(false)
  })

  it('does not narrow an unpinned turn merely because Chrome is explicit', () => {
    expect(composeTurnToolAllowlist(null, true)).toBeNull()
  })

  it('refuses Chrome discovery for SEO-only, but admits it for the exact SEO+Chrome incident', () => {
    const seoOnly = 'amr website er SEO shob page deeply check koro, report daw'
    const skillAllowlist = new Set(['find_tool', 'run_website_seo_audit'])
    const found = () => ({
      data: {
        matches: [
          { name: 'live_browser_look', description: 'look' },
          { name: 'live_browser_act', description: 'act' },
          { name: 'run_website_seo_audit', description: 'seo' },
        ],
        note: 'raw registry result',
      },
    })

    expect(hasExplicitChromeModality(seoOnly)).toBe(false)
    const seoResult = found()
    const seoFiltered = filterFindToolResultForTurn(seoResult, {
      already: new Set(),
      turnDenylist: new Set(),
      turnAllowlist: composeTurnToolAllowlist(skillAllowlist, false),
    })
    expect(seoFiltered.permitted).toEqual(['run_website_seo_audit'])
    expect(JSON.stringify(seoResult)).not.toContain('live_browser_look')
    expect(JSON.stringify(seoResult)).not.toContain('live_browser_act')

    expect(hasExplicitChromeModality(INCIDENT)).toBe(true)
    const chromeResult = found()
    const chromeFiltered = filterFindToolResultForTurn(chromeResult, {
      already: new Set(),
      turnDenylist: new Set(),
      turnAllowlist: composeTurnToolAllowlist(skillAllowlist, true),
    })
    expect(chromeFiltered.permitted).toEqual([
      'live_browser_look',
      'live_browser_act',
      'run_website_seo_audit',
    ])
  })

  it('applies the same permission-aware policy to initial and find_tool definitions', async () => {
    const tools = await resolveToolsByName([
      'find_tool',
      'run_website_seo_audit',
      ...EXPLICIT_CHROME_MODALITY_TOOLS,
      'draft_seo_fixes',
    ])
    const allowlist = composeTurnToolAllowlist(
      new Set(['find_tool', 'run_website_seo_audit']),
      true,
    )
    const policy = {
      ownerText: INCIDENT,
      turnAllowlist: allowlist,
      turnDenylist: new Set<string>(),
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' as const },
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'plan' as const,
      permissionMode: 'plan' as const,
      actorRoles: ['owner' as const],
    }

    const initial = filterTurnToolDefinitions(tools, policy)
    const discovered = filterTurnToolDefinitions(tools, policy)
    const initialNames = initial.tools.map((tool) => tool.name)

    expect(discovered.tools.map((tool) => tool.name)).toEqual(initialNames)
    expect(initialNames).toContain('live_browser_look')
    expect(initialNames).toContain('live_browser_status')
    expect(initialNames).not.toContain('live_browser_act')
    expect(initialNames).not.toContain('live_browser_pair')
    expect(initialNames).not.toContain('draft_seo_fixes')
  })

  it('uses the shared handler boundary for dynamic parity and leaks no refused preview names', async () => {
    const policy = {
      ownerText: 'amr website er SEO deeply check koro',
      turnAllowlist: new Set(['find_tool', 'run_website_seo_audit']),
      turnDenylist: new Set<string>(),
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' as const },
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'auto' as const,
      permissionMode: 'standard' as const,
      actorRoles: ['owner' as const],
    }
    const raw = {
      data: {
        matches: [
          { name: 'live_browser_look' },
          { name: 'live_browser_act' },
          { name: 'run_website_seo_audit' },
        ],
        note: 'raw registry result',
      },
    }
    const dynamic = await prepareFindToolResultForTurn({
      result: raw,
      query: '',
      already: new Set(),
      policy,
      max: 8,
    })
    const initialCandidates = await resolveToolsByName([
      'live_browser_look',
      'live_browser_act',
      'run_website_seo_audit',
    ])
    const initial = filterTurnToolDefinitions(initialCandidates, policy)

    expect(dynamic.tools.map((tool) => tool.name)).toEqual(initial.tools.map((tool) => tool.name))
    expect(dynamic.tools.map((tool) => tool.name)).toEqual(['run_website_seo_audit'])
    expect(JSON.stringify(raw)).not.toContain('live_browser_look')
    expect(JSON.stringify(raw)).not.toContain('live_browser_act')
  })

  it('preserves the AGENT_OWNER_INTENT_GATE=false kill switch', async () => {
    const [post] = await resolveToolsByName(['post_to_facebook'])
    const base = {
      ownerText: 'শুধু caption লিখে দাও, কোথাও post কোরো না',
      turnAllowlist: null,
      turnDenylist: new Set<string>(),
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' as const },
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'auto' as const,
      permissionMode: 'standard' as const,
      actorRoles: ['owner' as const],
    }
    expect(filterTurnToolDefinitions([post], base).tools).toEqual([])
    expect(filterTurnToolDefinitions([post], {
      ...base,
      ownerIntentGateEnabled: false,
    }).tools.map((tool) => tool.name)).toEqual(['post_to_facebook'])
  })

  it('filters health/callability before a deterministic bounded shortlist', () => {
    const tools = ['blocked_read', 'allowed_write', 'allowed_read'].map((name) => ({
      name,
      description: `${name} description`,
      input_schema: { type: 'object', properties: {} },
    }))
    const result = shortlistAvailableToolDefinitions(tools, {
      max: 2,
      isCatalogAvailable: (name) => name !== 'blocked_read',
      rank: (name) => name === 'allowed_read' ? [0, 0, name] : [2, 2, name],
    })

    expect(result.tools.map((tool) => tool.name)).toEqual(['allowed_read', 'allowed_write'])
    expect(result.refused).toEqual(['blocked_read'])
    expect(result.tools).toHaveLength(2)
  })

  it('returns an empty shortlist when no dynamic slots remain', () => {
    const tools = [{
      name: 'available',
      description: 'available',
      input_schema: { type: 'object', properties: {} },
    }]
    const result = shortlistAvailableToolDefinitions(tools, {
      max: 0,
      isCatalogAvailable: () => true,
    })
    expect(result.tools).toEqual([])
    expect(result.trimmed).toEqual(['available'])
  })

  it('uses the live semantic fallback seam, then filters health/permission before bounding', async () => {
    const result = await semanticFallbackToolDefinitions('opaque owner intent', {
      max: 1,
      semanticGroups: async () => ['growth'],
      toolsForGroups: async () => [
        {
          name: 'a_denied_semantic_top',
          description: 'top semantic result but unavailable',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'z_allowed_semantic_lower',
          description: 'lower semantic result and available',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      isCatalogAvailable: (name) => name !== 'a_denied_semantic_top',
    })

    expect(result.tools.map((tool) => tool.name)).toEqual(['z_allowed_semantic_lower'])
    expect(result.refused).toEqual(['a_denied_semantic_top'])
    expect(result.tools).toHaveLength(1)
  })

  it('minimizes the authoritative live-browser schema without erasing its contract', async () => {
    const [act] = await resolveToolsByName(['live_browser_act'])
    const [prepared] = filterTurnToolDefinitions([act], {
      ownerText: 'amar Chrome e click koro',
      turnAllowlist: null,
      turnDenylist: new Set(),
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' },
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'auto',
      permissionMode: 'standard',
      actorRoles: ['owner'],
    }).tools
    const schema = prepared.input_schema as {
      required?: string[]
      properties?: { action?: { enum?: string[] } }
    }

    expect(schema.required).toEqual(expect.arrayContaining(['action', 'device', 'observationReceipt']))
    expect(schema.properties?.action?.enum).toEqual(expect.arrayContaining(['navigate', 'click', 'type']))
  })
})
