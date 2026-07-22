import { describe, it, expect, afterEach } from 'vitest'
import { buildSelfCorrectionNudge } from '../self-correct'

describe('self-correct nudge (harness gap 1)', () => {
  afterEach(() => { delete process.env.AGENT_SELF_CORRECT })

  it('returns null with no failures', () => {
    expect(buildSelfCorrectionNudge([])).toBeNull()
  })

  it('kill switch AGENT_SELF_CORRECT=false returns null', () => {
    process.env.AGENT_SELF_CORRECT = 'false'
    expect(buildSelfCorrectionNudge([{ toolName: 'x', error: 'y' }])).toBeNull()
  })

  it('lists the failed tool + error and the recovery rules', () => {
    const nudge = buildSelfCorrectionNudge([{ toolName: 'get_orders', error: 'timeout after 30s' }])
    expect(nudge).toContain('get_orders')
    expect(nudge).toContain('timeout after 30s')
    expect(nudge).toContain('হুবহু একই call')
  })

  it('unknown-tool failures point at find_tool', () => {
    const nudge = buildSelfCorrectionNudge([{ toolName: 'send_whatsapp', error: 'Unknown tool: send_whatsapp' }])
    expect(nudge).toContain('find_tool')
  })

  it('dedupes repeated tool names and caps at 3 listed failures', () => {
    const nudge = buildSelfCorrectionNudge([
      { toolName: 'a', error: 'e1' },
      { toolName: 'a', error: 'e2' },
      { toolName: 'b', error: 'e3' },
      { toolName: 'c', error: 'e4' },
      { toolName: 'd', error: 'e5' },
    ])!
    expect(nudge.match(/^- /gm)?.length).toBe(3)
    expect(nudge).not.toContain('- d:')
  })

  it('long errors are truncated to keep the nudge compact', () => {
    const nudge = buildSelfCorrectionNudge([{ toolName: 'x', error: 'z'.repeat(1000) }])!
    expect(nudge.length).toBeLessThan(800)
  })
})
