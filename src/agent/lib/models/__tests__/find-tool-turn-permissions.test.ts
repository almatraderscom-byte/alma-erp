/**
 * find_tool must never advertise a tool the turn cannot use.
 *
 * Prod deadlock 2026-08-12, conversation 8b7b482e (unattended plan driver):
 * agent_tool_events showed `find_tool ok` → `check_order_issues FAIL
 * membership_gate/tool_not_shipped` → `get_orders FAIL`, repeating every
 * ~5-minute plan-driver tick. The grant block filtered find_tool's matches
 * through the pinned skill's allowlist and logged the refusals to console.info
 * ONLY — the result the MODEL read still listed the refused tools, so it called
 * them, and the membership gate sent it back to find_tool. Forever.
 *
 * filterFindToolResultForTurn is the fix: the refused matches are removed from
 * the result the model reads, and a note explains why and what to do instead.
 * These tests pin that contract.
 */
import { describe, it, expect } from 'vitest'
import { DIRECT_BROWSER_SHELL_DENYLIST } from '@/agent/lib/live-browser/intent'
import { filterFindToolResultForTurn } from '@/agent/lib/models/run-owner-turn'

const result = (names: string[], note?: string) => ({
  data: {
    matches: names.map((name) => ({ name, description: `${name} desc`, groups: ['reports'] })),
    ...(note ? { note } : {}),
  },
})

const NO_LISTS = { already: new Set<string>(), turnDenylist: new Set<string>(), turnAllowlist: null }

describe('filterFindToolResultForTurn — the find_tool → membership_gate deadlock', () => {
  it('removes allowlist-refused matches from the result the model reads and appends the refusal note', () => {
    // The exact prod shape: a pinned skill whose allowlist has neither tool.
    const res = result(['check_order_issues', 'get_orders', 'get_plan'], 'existing note')
    const { permitted, refused } = filterFindToolResultForTurn(res, {
      already: new Set(),
      turnDenylist: new Set(),
      turnAllowlist: new Set(['get_plan', 'update_plan_step']),
    })
    expect(permitted).toEqual(['get_plan'])
    expect(refused).toEqual(['check_order_issues', 'get_orders'])
    // The model must no longer SEE the unusable tools…
    expect(res.data.matches.map((m) => m.name)).toEqual(['get_plan'])
    // …and must be TOLD why they vanished, with an honest way out.
    expect(res.data.note).toContain('existing note')
    expect(res.data.note).toContain('[হারনেস] এই টার্নে অনুমোদিত নয় বলে বাদ: check_order_issues, get_orders।')
    expect(res.data.note).toContain('এগুলো call কোরো না')
  })

  it('denylisted matches are refused and edited out the same way', () => {
    const res = result(['ask_user', 'get_sales_summary'])
    const { permitted, refused } = filterFindToolResultForTurn(res, {
      already: new Set(),
      turnDenylist: new Set(['ask_user']),
      turnAllowlist: null,
    })
    expect(permitted).toEqual(['get_sales_summary'])
    expect(refused).toEqual(['ask_user'])
    expect(res.data.matches.map((m) => m.name)).toEqual(['get_sales_summary'])
    expect(String(res.data.note)).toContain('ask_user')
  })

  it('does not let a direct browser turn rediscover a shell fallback', () => {
    const denied = [...DIRECT_BROWSER_SHELL_DENYLIST]
    const res = result([...denied, 'live_browser_act'])
    const { permitted, refused } = filterFindToolResultForTurn(res, {
      already: new Set(),
      turnDenylist: DIRECT_BROWSER_SHELL_DENYLIST,
      turnAllowlist: new Set(['live_browser_act']),
    })

    expect(permitted).toEqual(['live_browser_act'])
    expect(refused).toEqual(denied)
    expect(res.data.matches.map((match) => match.name)).toEqual(['live_browser_act'])
  })

  it('leaves the result untouched when everything found is permitted', () => {
    const res = result(['get_orders'], 'schema পরের ধাপ থেকে available')
    const { permitted, refused } = filterFindToolResultForTurn(res, NO_LISTS)
    expect(permitted).toEqual(['get_orders'])
    expect(refused).toEqual([])
    expect(res.data.matches).toHaveLength(1)
    expect(res.data.note).toBe('schema পরের ধাপ থেকে available')
  })

  it('an already-shipped tool is neither re-granted nor refused — it stays visible and callable', () => {
    const res = result(['get_orders'])
    const { permitted, refused } = filterFindToolResultForTurn(res, {
      already: new Set(['get_orders']),
      turnDenylist: new Set(),
      turnAllowlist: new Set(['get_plan']), // does not list it — irrelevant, it is already live
    })
    expect(permitted).toEqual([])
    expect(refused).toEqual([])
    expect(res.data.matches.map((m) => m.name)).toEqual(['get_orders'])
    expect(res.data.note).toBeUndefined()
  })

  it('tolerates empty and malformed results', () => {
    expect(filterFindToolResultForTurn(undefined, NO_LISTS)).toEqual({ permitted: [], refused: [] })
    expect(filterFindToolResultForTurn({}, NO_LISTS)).toEqual({ permitted: [], refused: [] })
    expect(filterFindToolResultForTurn({ data: { matches: [] } }, NO_LISTS)).toEqual({ permitted: [], refused: [] })
  })
})
