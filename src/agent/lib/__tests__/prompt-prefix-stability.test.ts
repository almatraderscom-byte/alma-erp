/**
 * Cost audit Phase 8d — the cached prefix must not move when the tool selection does.
 *
 * Measured in production: two turns of the SAME conversation, 25s apart, produced
 * 65 vs 62 prompt sections — `VISION TOOLS (File 17)` and `OUTCOME SIMULATION
 * (File 18)` were present in one and absent in the next, because prompt modules
 * are gated on the turn's tool selection. Every downstream byte shifted, so the
 * provider prompt cache missed and the whole ~46k prefix was re-billed at the full
 * input rate ($1.25/Mtok on Grok vs $0.20 cached — 6.25x).
 *
 * `forceFullPrompt` ships every module regardless of the selection, making the
 * prefix byte-identical between turns. These lock down both halves: gated mode
 * still varies (so the diagnosis stays true) and full mode does not.
 */
import { describe, it, expect } from 'vitest'
import { buildSystemPromptBlocks } from '@/agent/lib/system-prompt'

function systemTextFor(opts: {
  activeGroups?: Parameters<typeof buildSystemPromptBlocks>[0]['activeGroups']
  activeToolNames?: string[]
  forceFullPrompt?: boolean
}) {
  const { stable } = buildSystemPromptBlocks({
    businessId: 'ALMA_LIFESTYLE',
    activeGroups: opts.activeGroups,
    activeToolNames: opts.activeToolNames,
    forceFullPrompt: opts.forceFullPrompt,
  })
  return stable.map((b) => b.text).join('\n')
}

// Two plausible consecutive turns: a data question, then a bare acknowledgement.
const TURN_A = { activeGroups: ['growth', 'vision'] as never, activeToolNames: ['get_sales_summary', 'analyze_image'] }
const TURN_B = { activeGroups: ['base'] as never, activeToolNames: ['get_orders'] }

describe('prompt prefix stability across a changing tool selection', () => {
  it('GATED mode: the prefix moves between turns (the bug being diagnosed)', () => {
    const a = systemTextFor(TURN_A)
    const b = systemTextFor(TURN_B)
    expect(a).not.toBe(b)
  })

  it('FULL mode: the prefix is byte-identical despite different tool selections', () => {
    const a = systemTextFor({ ...TURN_A, forceFullPrompt: true })
    const b = systemTextFor({ ...TURN_B, forceFullPrompt: true })
    expect(a).toBe(b)
  })

  it('FULL mode is a superset — nothing the gated prompt taught is dropped', () => {
    const gated = systemTextFor(TURN_A)
    const full = systemTextFor({ ...TURN_A, forceFullPrompt: true })
    // Section headings present when gated must still be present when full.
    const headings = (t: string) => (t.match(/^#{2,3} .+$/gm) ?? [])
    for (const h of headings(gated)) expect(full).toContain(h)
    expect(full.length).toBeGreaterThanOrEqual(gated.length)
  })

  it('default (no flag) keeps today\'s gated behaviour', () => {
    expect(systemTextFor(TURN_A)).toBe(systemTextFor({ ...TURN_A, forceFullPrompt: undefined }))
  })
})
