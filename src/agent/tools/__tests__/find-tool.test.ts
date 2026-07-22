import { describe, it, expect } from 'vitest'
import {
  searchToolInventory,
  resolveToolsByName,
  find_tool,
  MAX_DYNAMIC_TOOLS_PER_TURN,
} from '../find-tool'

describe('find_tool (harness gap 5)', () => {
  it('finds send_whatsapp from a capability query — the live 2026-07-22 failure', async () => {
    const matches = await searchToolInventory('whatsapp send message')
    expect(matches.map((m) => m.name)).toContain('send_whatsapp')
  })

  it('finds camera_speak by name fragment', async () => {
    const matches = await searchToolInventory('camera_speak')
    expect(matches[0]?.name).toBe('camera_speak')
  })

  it('returns [] for a capability that truly does not exist', async () => {
    expect(await searchToolInventory('teleport warehouse to mars')).toEqual([])
  })

  it('caps matches at the per-turn dynamic-load limit', async () => {
    const matches = await searchToolInventory('get')
    expect(matches.length).toBeLessThanOrEqual(MAX_DYNAMIC_TOOLS_PER_TURN)
  })

  it('resolveToolsByName returns executable AgentTools with schemas', async () => {
    const tools = await resolveToolsByName(['send_whatsapp', 'nonexistent_tool'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('send_whatsapp')
    expect(tools[0].input_schema).toBeDefined()
    expect(typeof tools[0].handler).toBe('function')
  })

  it('handler returns matches for the loop to load', async () => {
    const res = await find_tool.handler({ query: 'urgent alert' })
    expect(res.success).toBe(true)
    const names = (res.data as { matches: Array<{ name: string }> }).matches.map((m) => m.name)
    expect(names).toContain('send_urgent_alert')
  })

  it('handler with empty query fails cleanly', async () => {
    const res = await find_tool.handler({ query: '' })
    expect(res.success).toBe(false)
  })

  it('handler reports honest empty result with Bangla note', async () => {
    const res = await find_tool.handler({ query: 'zzzz_no_such_capability_zzzz' })
    expect(res.success).toBe(true)
    const data = res.data as { matches: unknown[]; note: string }
    expect(data.matches).toEqual([])
    expect(data.note).toContain('নেই')
  })
})
